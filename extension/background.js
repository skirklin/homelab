// Background service worker for Money Data Collector extension.
// Routes browser events to per-institution handlers.

import ally from "./institutions/ally.js";
import betterment from "./institutions/betterment.js";
import capital_one from "./institutions/capital_one.js";
import chase from "./institutions/chase.js";
import morgan_stanley from "./institutions/morgan_stanley.js";
import wealthfront from "./institutions/wealthfront.js";

const DEFAULT_PORT = 5555;

// ── Institution registry ─────────────────────────────────────────────

const HANDLERS = {
  ally,
  betterment,
  capital_one,
  chase,
  morgan_stanley,
  wealthfront,
};

// Build URL→institution lookup from handler domains
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
  const result = await chrome.storage.local.get("serverPort");
  const port = result.serverPort || DEFAULT_PORT;
  return `http://localhost:${port}`;
}

async function sendToServer(endpoint, data) {
  const baseUrl = await getServerUrl();
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Server returned ${response.status}: ${text}` };
    }
    return { success: true, data: await response.json() };
  } catch (err) {
    return { success: false, error: `Connection failed: ${err.message}` };
  }
}

async function checkServerHealth() {
  const baseUrl = await getServerUrl();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

// ── Badge & logging ──────────────────────────────────────────────────

function setBadge(text, color = "#34d399") {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function logActivity(message) {
  const result = await chrome.storage.local.get("activityLog");
  const log = result.activityLog || [];
  log.unshift({ time: new Date().toISOString(), message });
  await chrome.storage.local.set({ activityLog: log.slice(0, 20) });
}

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

async function sendCookiesToServer(institution, cookies) {
  if (cookies.length === 0) return { success: false, error: "No cookies" };
  return await sendToServer("/cookies", {
    institution,
    cookies,
    captured_at: new Date().toISOString(),
  });
}

// ── Network recording state ──────────────────────────────────────────

const networkBuffer = {};    // institution -> [entries]
const recordingTabs = {};    // tabId -> institution

function updateRecordingBadge() {
  const institutions = Object.values(recordingTabs);
  if (institutions.length === 0) { setBadge(""); return; }
  let total = 0;
  for (const inst of institutions) {
    total += (networkBuffer[inst] || []).length;
  }
  setBadge(String(total), total > 0 ? "#818cf8" : "#34d399");
}

// ── Handler context ──────────────────────────────────────────────────
// Passed to each handler's onPageLoad — provides the tools they need.

function makeContext(institution, tabId) {
  const handler = HANDLERS[institution];

  return {
    institution,
    tabId,

    async triggerSync() {
      const result = await sendToServer("/trigger-sync", { institution });
      return { type: "sync_triggered", ...result };
    },

    async captureCookies() {
      const cookies = await getAllCookiesForDomains(handler.domains);
      const result = await sendCookiesToServer(institution, cookies);
      return { type: "cookies", count: cookies.length, ...result };
    },

    async waitForCookies(requiredNames, { timeout = 15000, interval = 1000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const cookies = await getAllCookiesForDomains(handler.domains);
        const names = new Set(cookies.map(c => c.name));
        const missing = requiredNames.filter(n => !names.has(n));
        if (missing.length === 0) {
          const result = await sendCookiesToServer(institution, cookies);
          return { type: "cookies", count: cookies.length, ...result };
        }
        console.log(`[Money] ${institution}: waiting for cookies: ${missing.join(", ")}`);
        await new Promise(resolve => setTimeout(resolve, interval));
      }
      // Timeout — send whatever we have
      console.warn(`[Money] ${institution}: timed out waiting for required cookies`);
      const cookies = await getAllCookiesForDomains(handler.domains);
      const result = await sendCookiesToServer(institution, cookies);
      return { type: "cookies", count: cookies.length, timedOut: true, ...result };
    },

    async startNetworkRecording() {
      networkBuffer[institution] = [];
      recordingTabs[tabId] = institution;
      try {
        await chrome.tabs.sendMessage(tabId, { type: "START_RECORDING" });
        updateRecordingBadge();
        logActivity(`Started recording for ${institution}`);
      } catch (err) {
        console.warn(`[Money] Could not start recording for ${institution}:`, err);
      }
    },

    async executeInPage(fn, args = undefined) {
      // Inject as a <script> tag in the page DOM so it runs with the page's
      // full session (cookies, auth). chrome.scripting.executeScript with
      // world: "MAIN" doesn't share the page's credentials for fetch.
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

    async getLastSync() {
      const baseUrl = await getServerUrl();
      try {
        const resp = await fetch(`${baseUrl}/api/last-sync?institution=${institution}`);
        if (resp.ok) return await resp.json();
      } catch { /* server not available */ }
      return null;
    },

    async flushNetworkLog() {
      const entries = networkBuffer[institution] || [];
      if (entries.length === 0) {
        return { type: "network_log", count: 0, success: true };
      }
      const toSend = [...entries];
      networkBuffer[institution] = [];
      const result = await sendToServer("/network-log", {
        institution,
        entries: toSend,
        captured_at: new Date().toISOString(),
      });
      if (result.success) {
        updateRecordingBadge();
        logActivity(`Flushed ${toSend.length} network entries for ${institution}`);
      }
      return { type: "network_log", count: toSend.length, ...result };
    },
  };
}

// ── Cooldown tracking ────────────────────────────────────────────────

const lastCapture = {};
const COOLDOWN_MS = 30_000;

// Track institutions with an active handler running (suppresses periodic flush)
const activeHandlers = new Set();

// ── Navigation handler (the router) ──────────────────────────────────

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const institution = getInstitutionForUrl(details.url);
  if (!institution) return;

  const handler = HANDLERS[institution];
  if (!handler) return;

  // Check auth pattern
  if (handler.authPattern && !handler.authPattern.test(details.url)) return;

  // Cooldown
  const now = Date.now();
  if (lastCapture[institution] && now - lastCapture[institution] < COOLDOWN_MS) return;
  lastCapture[institution] = now;

  // Dispatch to handler
  const ctx = makeContext(institution, details.tabId);
  activeHandlers.add(institution);
  try {
    const result = await handler.onPageLoad(ctx);
    if (result && result.success !== false) {
      setBadge("✓");
      const desc = result.count
        ? `Captured ${result.count} entries for ${institution}`
        : `Completed ${institution}`;
      logActivity(desc);
      console.log(`[Money] ${desc}`);
    } else {
      setBadge("!", "#f87171");
      logActivity(`Failed for ${institution}: ${result?.error || "unknown"}`);
    }
  } catch (err) {
    setBadge("!", "#f87171");
    console.error(`[Money] Handler error for ${institution}:`, err);
    logActivity(`Error for ${institution}: ${err.message}`);
  } finally {
    activeHandlers.delete(institution);
  }
});

// ── Periodic network flush ───────────────────────────────────────────

setInterval(async () => {
  for (const [tabId, institution] of Object.entries(recordingTabs)) {
    // Don't flush while a handler is actively running — it controls its own flush
    if (activeHandlers.has(institution)) continue;

    const entries = networkBuffer[institution];
    if (!entries || entries.length === 0) continue;

    const toSend = [...entries];
    networkBuffer[institution] = [];

    const result = await sendToServer("/network-log", {
      institution,
      entries: toSend,
      captured_at: new Date().toISOString(),
    });
    if (result.success) {
      updateRecordingBadge();
      logActivity(`Flushed ${toSend.length} network entries for ${institution}`);
    } else {
      setBadge("!", "#f87171");
    }
  }
}, 30_000);

// ── Tab navigation/close → flush network logs ────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;
  const institution = recordingTabs[tabId];
  if (!institution) return;

  if (getInstitutionForUrl(changeInfo.url) === institution) return;

  delete recordingTabs[tabId];
  const entries = networkBuffer[institution] || [];
  if (entries.length > 0) {
    await sendToServer("/network-log", {
      institution, entries, captured_at: new Date().toISOString(),
    });
  }
  delete networkBuffer[institution];
  updateRecordingBadge();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const institution = recordingTabs[tabId];
  if (!institution) return;

  delete recordingTabs[tabId];
  const entries = networkBuffer[institution] || [];
  if (entries.length > 0) {
    await sendToServer("/network-log", {
      institution, entries, captured_at: new Date().toISOString(),
    });
  }
  delete networkBuffer[institution];
  updateRecordingBadge();
});

// ── Message handler (popup, content scripts) ─────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_HEALTH") {
    checkServerHealth().then(healthy => sendResponse({ healthy }));
    return true;
  }

  if (message.type === "CAPTURE_COOKIES") {
    const handler = HANDLERS[message.institution];
    if (!handler) {
      sendResponse({ success: false, error: `Unknown institution: ${message.institution}` });
      return true;
    }
    getAllCookiesForDomains(handler.domains).then(async cookies => {
      const result = await sendCookiesToServer(message.institution, cookies);
      sendResponse({ ...result, count: cookies.length });
    });
    return true;
  }

  if (message.type === "NETWORK_REQUEST") {
    const tabId = sender.tab?.id;
    const institution = tabId ? recordingTabs[tabId] : null;
    if (institution && message.entry) {
      // Apply per-institution capture filter if defined
      const handler = HANDLERS[institution];
      const url = message.entry.url || "";
      if (!handler?.captureFilter || handler.captureFilter.test(url)) {
        if (!networkBuffer[institution]) networkBuffer[institution] = [];
        networkBuffer[institution].push(message.entry);
        updateRecordingBadge();
      }
    }
    sendResponse({ buffered: true });
    return true;
  }

  if (message.type === "AUTH_TOKEN") {
    const tabUrl = sender.tab?.url || "";
    const institution = getInstitutionForUrl(tabUrl);
    if (institution && message.token) {
      sendToServer("/auth-token", {
        institution,
        token: message.token,
        tokenType: message.tokenType || "Bearer",
        expiresIn: message.expiresIn,
        captured_at: new Date().toISOString(),
      }).then(sendResponse);
    } else {
      sendResponse({ success: false, error: "Unknown institution" });
    }
    return true;
  }

  if (message.type === "START_NETWORK_RECORDING") {
    const { tabId, institution } = message;
    networkBuffer[institution] = [];
    recordingTabs[tabId] = institution;
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/network_recorder.js"],
    }).then(() => chrome.tabs.sendMessage(tabId, { type: "START_RECORDING" }))
      .then(sendResponse)
      .catch(err => sendResponse({ started: false, error: err.message }));
    return true;
  }

  if (message.type === "STOP_NETWORK_RECORDING") {
    const { tabId, institution } = message;
    delete recordingTabs[tabId];
    chrome.tabs.sendMessage(tabId, { type: "STOP_RECORDING" }).then(async () => {
      const entries = networkBuffer[institution] || [];
      const result = await sendToServer("/network-log", {
        institution, entries, captured_at: new Date().toISOString(),
      });
      delete networkBuffer[institution];
      sendResponse({ ...result, count: entries.length });
    }).catch(async () => {
      const entries = networkBuffer[institution] || [];
      const result = await sendToServer("/network-log", {
        institution, entries, captured_at: new Date().toISOString(),
      });
      delete networkBuffer[institution];
      sendResponse({ ...result, count: entries.length });
    });
    return true;
  }

  if (message.type === "GET_RECORDING_STATUS") {
    const { tabId } = message;
    const institution = recordingTabs[tabId] || null;
    const count = institution ? (networkBuffer[institution] || []).length : 0;
    sendResponse({ recording: !!institution, institution, count });
    return true;
  }

  if (message.type === "CHECK_RECORDING_FOR_TAB") {
    const tabId = sender.tab?.id;
    const shouldRecord = tabId && tabId in recordingTabs;
    sendResponse({ shouldRecord: !!shouldRecord });
    return true;
  }
});
