/**
 * Money Data Collector — Chrome Extension Background Service Worker
 *
 * Data flow:
 *   1. User navigates to a financial site
 *   2. webNavigation fires → URL matched to a handler
 *   3. Handler's onPageLoad(ctx) starts recording, waits, then calls ctx.capture()
 *   4. capture() sends cookies + network entries in one POST to /capture
 *   5. Server extracts user identity, triggers institution-specific sync
 */

import ally from "./institutions/ally.js";
import betterment from "./institutions/betterment.js";
import capital_one from "./institutions/capital_one.js";
import chase from "./institutions/chase.js";
import fidelity from "./institutions/fidelity.js";
import morgan_stanley from "./institutions/morgan_stanley.js";
import wealthfront from "./institutions/wealthfront.js";

const DEFAULT_SERVER_URL = "https://homelab-0.tail56ca88.ts.net:8443";

// ── Institution registry ─────────────────────────────────────────────

const HANDLERS = {
  ally, betterment, capital_one, chase, fidelity, morgan_stanley, wealthfront,
};

function getInstitutionForUrl(url) {
  if (!url) return null;
  for (const [id, handler] of Object.entries(HANDLERS)) {
    for (const domain of handler.domains) {
      if (url.includes(domain.replace(/^\./, ""))) return id;
    }
  }
  return null;
}

// ── Server communication ─────────────────────────────────────────────

async function getServerUrl() {
  const result = await chrome.storage.local.get("serverUrl");
  return (result.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

async function postToServer(endpoint, data) {
  const baseUrl = await getServerUrl();
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Server ${response.status}: ${text}` };
    }
    return { success: true, data: await response.json() };
  } catch (err) {
    return { success: false, error: `Connection failed: ${err.message}` };
  }
}

async function getFromServer(path) {
  const baseUrl = await getServerUrl();
  try {
    const resp = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) return await resp.json();
  } catch { /* server not available */ }
  return null;
}

// ── Badge & logging ──────────────────────────────────────────────────

let badgeTimer = null;

function setBadge(text, color = "#34d399", { persist = false } = {}) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (badgeTimer) clearTimeout(badgeTimer);
  if (!persist && text) {
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
  }
}

async function logActivity(message) {
  const result = await chrome.storage.local.get("activityLog");
  const log = result.activityLog || [];
  log.unshift({ time: new Date().toISOString(), message });
  await chrome.storage.local.set({ activityLog: log.slice(0, 20) });
}

// ── Update check ────────────────────────────────────────────────────

async function checkForUpdate() {
  const data = await getFromServer("/extension/version");
  if (!data) return;
  const current = chrome.runtime.getManifest().version;
  if (data.version && data.version !== current && data.available) {
    await chrome.storage.local.set({ updateAvailable: data.version });
    setBadge("⬆", "#f59e0b", { persist: true });
    logActivity(`Update available: v${data.version} (you have v${current})`);
  } else {
    await chrome.storage.local.remove("updateAvailable");
  }
}
checkForUpdate();
setInterval(checkForUpdate, 6 * 60 * 60 * 1000);

// ── Cookie capture ───────────────────────────────────────────────────

async function getAllCookiesForDomains(domains) {
  const allCookies = [];
  const seen = new Set();
  for (const domain of domains) {
    const byDomain = await chrome.cookies.getAll({ domain });
    const byUrl = await chrome.cookies.getAll({ url: `https://${domain.replace(/^\./, "")}` });
    for (const cookie of [...byDomain, ...byUrl]) {
      const key = `${cookie.domain}|${cookie.name}|${cookie.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        allCookies.push(cookie);
      }
    }
  }
  return allCookies;
}

// ── Network recording ───────────────────────────────────────────────

const networkBuffer = {};    // institution -> [entries]
const recordingTabs = {};    // tabId -> institution

function updateBadge() {
  let total = 0;
  for (const inst of Object.values(recordingTabs)) {
    total += (networkBuffer[inst] || []).length;
  }
  if (total > 0) setBadge(String(total), "#818cf8");
}

// ── Handler context ──────────────────────────────────────────────────

function makeContext(institution, tabId) {
  const handler = HANDLERS[institution];
  let userIdentity = null;

  return {
    institution,
    tabId,

    /** Set a user identity extracted from the page (name, email, etc). */
    setUserIdentity(id) { userIdentity = id; },

    /** Run a function in the page's JS context and return its result. */
    async scrapeText(fn) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId }, func: fn, world: "MAIN",
        });
        return results?.[0]?.result || null;
      } catch { return null; }
    },

    /** Inject a function into the page context (fire-and-forget). */
    async executeInPage(fn, args = undefined) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (fnSource, fnArgs) => {
          const script = document.createElement("script");
          script.textContent = `(${fnSource})(${JSON.stringify(fnArgs)});`;
          document.documentElement.appendChild(script);
          script.remove();
        },
        args: [fn.toString(), args],
        world: "MAIN",
      });
    },

    /** Start recording network requests on this tab. */
    async startRecording() {
      networkBuffer[institution] = [];
      recordingTabs[tabId] = institution;
      try {
        await chrome.tabs.sendMessage(tabId, { type: "START_RECORDING" });
      } catch { /* content script not ready yet — autoRecord handles it */ }
    },

    /** Wait ms milliseconds. */
    wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },

    /** Find an auth token in buffered network responses (for Ally). */
    findCapturedToken() {
      for (const entry of networkBuffer[institution] || []) {
        const body = entry.responseBody;
        if (!body || typeof body !== "object") continue;
        const token = body?.data?.data?.json_data?.access_token;
        if (token) return token;
        if (body?.data?.access_token) return body.data.access_token;
      }
      return null;
    },

    /** Ask the server for the last sync date for this institution. */
    async getLastSync() {
      return await getFromServer(`/api/last-sync?institution=${institution}`);
    },

    /** Get the currently buffered network entries. */
    getBufferedEntries() {
      return networkBuffer[institution] || [];
    },

    /**
     * Wait until buffered entries contain URLs matching all the given patterns,
     * or until timeout (default 30s). Returns true if all matched.
     */
    async waitForEntries(patterns, { timeout = 30000 } = {}) {
      console.log(`[Money] ${institution}: waiting for ${patterns.length} pattern(s)...`);
      const deadline = Date.now() + timeout;
      const found = new Set();
      while (Date.now() < deadline) {
        const entries = networkBuffer[institution] || [];
        const urls = entries.map(e => e.url || "");
        for (let i = 0; i < patterns.length; i++) {
          if (found.has(i)) continue;
          const p = patterns[i];
          if (urls.some(u => typeof p === "string" ? u.includes(p) : p.test(u))) {
            found.add(i);
            console.log(`[Money] ${institution}: found ${p} (${found.size}/${patterns.length})`);
          }
        }
        if (found.size === patterns.length) {
          console.log(`[Money] ${institution}: all patterns matched (${entries.length} entries buffered)`);
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const missing = patterns.filter((_, i) => !found.has(i));
      const entries = networkBuffer[institution] || [];
      console.warn(`[Money] ${institution}: timed out waiting for: ${missing.join(", ")} (${entries.length} entries buffered)`);
      return false;
    },

    /**
     * Send all captured data (cookies + network entries) to the server.
     * This is the main capture method — call it when the handler is done.
     */
    async capture() {
      const cookies = await getAllCookiesForDomains(handler.domains);
      const entries = [...(networkBuffer[institution] || [])];
      delete networkBuffer[institution];
      delete recordingTabs[tabId];

      const payload = {
        institution,
        cookies,
        entries,
        captured_at: new Date().toISOString(),
      };
      if (userIdentity) payload.user_identity = userIdentity;

      const result = await postToServer("/capture", payload);

      if (result.success) {
        updateBadge();
        logActivity(`Captured ${cookies.length} cookies + ${entries.length} entries for ${institution}`);
      }

      if (result.success && result.data?.sync_id) {
        result.sync_id = result.data.sync_id;
      }
      return result;
    },

    /** Poll for sync completion. */
    async pollSyncResult(syncId, { timeout = 120000, interval = 2000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const data = await getFromServer(`/api/sync/${syncId}`);
        if (data && (data.status === "complete" || data.status === "error")) {
          return data;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
      return { status: "timeout" };
    },
  };
}

// ── Navigation handler ──────────────────────────────────────────────

const lastCapture = {};
const COOLDOWN_MS = 30_000;
const activeHandlers = new Set();

async function handleNavigation(details) {
  if (details.frameId !== 0) return;

  const institution = getInstitutionForUrl(details.url);
  if (!institution) return;

  const handler = HANDLERS[institution];
  if (!handler) return;
  if (handler.authPattern && !handler.authPattern.test(details.url)) return;

  const now = Date.now();
  if (lastCapture[institution] && now - lastCapture[institution] < COOLDOWN_MS) return;

  const ctx = makeContext(institution, details.tabId);
  activeHandlers.add(institution);
  try {
    const result = await handler.onPageLoad(ctx);

    if (result?.status === "complete" || result?.success !== false) {
      lastCapture[institution] = Date.now();
    }

    if (result?.status === "error") {
      setBadge("!", "#f87171");
      logActivity(`${institution}: sync failed — ${result.error_message || "unknown error"}`);
    } else if (result?.status === "complete") {
      setBadge("✓");
      const parts = [];
      if (result.accounts) parts.push(`${result.accounts} accounts`);
      if (result.transactions) parts.push(`${result.transactions} new transactions`);
      if (result.balances) parts.push(`${result.balances} new balances`);
      if (result.holdings) parts.push(`${result.holdings} new holdings`);
      logActivity(parts.length > 0 ? `${institution}: ${parts.join(", ")}` : `${institution}: synced`);
    } else if (result?.status === "timeout") {
      setBadge("?", "#fbbf24");
      logActivity(`${institution}: sync timed out`);
    } else if (result && result.success !== false) {
      setBadge("✓");
    } else {
      setBadge("!", "#f87171");
      logActivity(`Failed for ${institution}: ${result?.error || "unknown"}`);
    }
  } catch (err) {
    setBadge("!", "#f87171");
    logActivity(`Error for ${institution}: ${err.message}`);
  } finally {
    activeHandlers.delete(institution);
  }
}

chrome.webNavigation.onCompleted.addListener(handleNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

// ── Message handler (content scripts + popup) ───────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_HEALTH") {
    getFromServer("/health").then(data => sendResponse({ healthy: !!data }));
    return true;
  }

  // Network entry from page interceptor
  if (message.type === "NETWORK_REQUEST") {
    const tabId = sender.tab?.id;
    const institution = tabId ? recordingTabs[tabId] : null;
    if (institution && message.entry) {
      const handler = HANDLERS[institution];
      const url = message.entry.url || "";
      if (!handler?.captureFilter || handler.captureFilter.test(url)) {
        if (!networkBuffer[institution]) networkBuffer[institution] = [];
        networkBuffer[institution].push(message.entry);
        updateBadge();
      }
    }
    sendResponse({ buffered: true });
    return true;
  }

  // Content script checking if it should auto-start recording
  if (message.type === "CHECK_RECORDING_FOR_TAB") {
    const tabId = sender.tab?.id;
    const url = sender.tab?.url || "";
    if (tabId && tabId in recordingTabs) {
      sendResponse({ shouldRecord: true });
      return true;
    }
    const institution = getInstitutionForUrl(url);
    if (institution && tabId) {
      networkBuffer[institution] = networkBuffer[institution] || [];
      recordingTabs[tabId] = institution;
      updateBadge();
      sendResponse({ shouldRecord: true });
      return true;
    }
    sendResponse({ shouldRecord: false });
    return true;
  }
});
