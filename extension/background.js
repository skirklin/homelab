// Background service worker for Money Data Collector extension.
// Receives data from content scripts and forwards to the local server.

const DEFAULT_PORT = 5555;

// Cookie domains per institution
const COOKIE_DOMAINS = {
  ally: [".ally.com", "secure.ally.com", "wwws.ally.com"],
  wealthfront: [".wealthfront.com", "www.wealthfront.com"],
  betterment: [".betterment.com", "wwws.betterment.com"],
  morgan_stanley: [".morganstanley.com", "stockplanconnect.morganstanley.com", "www.morganstanley.com", ".solium.com", "shareworks.solium.com"],
  capital_one: [".capitalone.com", "myaccounts.capitalone.com", "www.capitalone.com"],
  bofa: [".bankofamerica.com", "secure.bankofamerica.com", "www.bankofamerica.com"],
  chase: [".chase.com", "secure.chase.com", "secure03b.chase.com", "www.chase.com"],
};

async function getServerUrl() {
  const result = await chrome.storage.local.get("serverPort");
  const port = result.serverPort || DEFAULT_PORT;
  return `http://localhost:${port}`;
}

async function sendToServer(endpoint, data) {
  const baseUrl = await getServerUrl();
  const url = `${baseUrl}${endpoint}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Server returned ${response.status}: ${text}` };
    }

    const result = await response.json();
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: `Connection failed: ${err.message}` };
  }
}

async function checkServerHealth() {
  const baseUrl = await getServerUrl();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

async function captureCookies(institution) {
  const domains = COOKIE_DOMAINS[institution];
  if (!domains) return { success: false, error: `Unknown institution: ${institution}` };

  const allCookies = [];
  const seen = new Set();

  // Query by domain AND by URL to catch all cookies
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

  if (allCookies.length === 0) {
    return { success: false, error: `No cookies found for ${institution}` };
  }

  // Send cookies to local server
  const payload = {
    institution,
    cookies: allCookies,
    captured_at: new Date().toISOString(),
  };

  const result = await sendToServer("/cookies", payload);

  if (result.success) {
    return { success: true, count: allCookies.length };
  }
  return result;
}

// Network recording state
const networkBuffer = {}; // institutionId -> [entries]
const recordingTabs = {}; // tabId -> institutionId

function getInstitutionForUrl(url) {
  if (!url) return null;
  for (const [id, domains] of Object.entries(COOKIE_DOMAINS)) {
    for (const domain of domains) {
      if (url.includes(domain.replace(/^\./, ""))) return id;
    }
  }
  return null;
}

// Institutions that need network recording (can't replay cookies)
const NETWORK_LOG_INSTITUTIONS = new Set(["chase", "morgan_stanley"]);

// Debounce auto-capture: don't re-send cookies for the same institution within 30s
const lastAutoCapture = {};
const AUTO_CAPTURE_COOLDOWN_MS = 30_000;

// URL patterns that indicate an authenticated session (past login)
const AUTHENTICATED_URL_PATTERNS = {
  capital_one: /myaccounts\.capitalone\.com\/(accountSummary|accountDetail)/,
  betterment: /app\.betterment\.com\/(investing|summary|goals)/,
  wealthfront: /www\.wealthfront\.com\/(dashboard|portfolio|transfers)/,
};

// Auto-capture cookies when navigating to an authenticated page
chrome.webNavigation.onCompleted.addListener(async (details) => {
  // Only main frame, not iframes
  if (details.frameId !== 0) return;

  const institution = getInstitutionForUrl(details.url);
  if (!institution) return;

  // Only auto-capture if the URL looks like an authenticated page
  const authPattern = AUTHENTICATED_URL_PATTERNS[institution];
  if (authPattern && !authPattern.test(details.url)) {
    return;
  }

  // Cooldown check
  const now = Date.now();
  if (lastAutoCapture[institution] && now - lastAutoCapture[institution] < AUTO_CAPTURE_COOLDOWN_MS) {
    return;
  }
  lastAutoCapture[institution] = now;

  // Auto-capture cookies
  const result = await captureCookies(institution);
  if (result.success) {
    console.log(`[Money] Auto-captured ${result.count} cookies for ${institution}`);
  }

  // Auto-start network recording for institutions that need it.
  // The content script is already injected by manifest.json content_scripts,
  // so we just need to send the START_RECORDING message.
  if (NETWORK_LOG_INSTITUTIONS.has(institution) && !recordingTabs[details.tabId]) {
    networkBuffer[institution] = [];
    recordingTabs[details.tabId] = institution;
    try {
      await chrome.tabs.sendMessage(details.tabId, { type: "START_RECORDING" });
      console.log(`[Money] Auto-started network recording for ${institution}`);
    } catch (err) {
      console.warn(`[Money] Could not start recording for ${institution}:`, err);
    }
  }
});

// Auto-flush network log when navigating away from a recorded tab
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;

  const institution = recordingTabs[tabId];
  if (!institution) return;

  // Check if the new URL is still the same institution
  const newInstitution = getInstitutionForUrl(changeInfo.url);
  if (newInstitution === institution) return;

  // Navigated away — flush the network log
  delete recordingTabs[tabId];
  const entries = networkBuffer[institution] || [];
  if (entries.length > 0) {
    const result = await sendToServer("/network-log", {
      institution,
      entries,
      captured_at: new Date().toISOString(),
    });
    console.log(`[Money] Auto-flushed ${entries.length} network entries for ${institution}:`, result);
  }
  delete networkBuffer[institution];
});

// Also flush when a recorded tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const institution = recordingTabs[tabId];
  if (!institution) return;

  delete recordingTabs[tabId];
  const entries = networkBuffer[institution] || [];
  if (entries.length > 0) {
    await sendToServer("/network-log", {
      institution,
      entries,
      captured_at: new Date().toISOString(),
    });
    console.log(`[Money] Auto-flushed ${entries.length} entries for ${institution} (tab closed)`);
  }
  delete networkBuffer[institution];
});

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_HEALTH") {
    checkServerHealth().then((healthy) => sendResponse({ healthy }));
    return true;
  }

  if (message.type === "CAPTURE_COOKIES") {
    captureCookies(message.institution).then(sendResponse);
    return true;
  }

  if (message.type === "NETWORK_REQUEST") {
    // Buffer a captured network request from a content script
    const tabId = sender.tab?.id;
    const institution = tabId ? recordingTabs[tabId] : null;
    if (institution && message.entry) {
      if (!networkBuffer[institution]) networkBuffer[institution] = [];
      networkBuffer[institution].push(message.entry);
    }
    sendResponse({ buffered: true });
    return true;
  }

  if (message.type === "AUTH_TOKEN") {
    // Relay captured auth token to the server
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
    const tabId = message.tabId;
    const institution = message.institution;
    networkBuffer[institution] = [];
    recordingTabs[tabId] = institution;
    // Inject content script if not already present, then start recording
    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/network_recorder.js"],
    }).then(() => {
      return chrome.tabs.sendMessage(tabId, { type: "START_RECORDING" });
    }).then(sendResponse).catch((err) => {
      sendResponse({ started: false, error: err.message });
    });
    return true;
  }

  if (message.type === "STOP_NETWORK_RECORDING") {
    const tabId = message.tabId;
    const institution = message.institution;
    delete recordingTabs[tabId];
    // Tell the content script to stop
    chrome.tabs.sendMessage(tabId, { type: "STOP_RECORDING" }).then(async () => {
      const entries = networkBuffer[institution] || [];
      const result = await sendToServer("/network-log", {
        institution,
        entries,
        captured_at: new Date().toISOString(),
      });
      delete networkBuffer[institution];
      sendResponse({ ...result, count: entries.length });
    }).catch(async () => {
      // Content script gone — just flush what we have
      const entries = networkBuffer[institution] || [];
      const result = await sendToServer("/network-log", {
        institution,
        entries,
        captured_at: new Date().toISOString(),
      });
      delete networkBuffer[institution];
      sendResponse({ ...result, count: entries.length });
    });
    return true;
  }

  if (message.type === "GET_RECORDING_STATUS") {
    const tabId = message.tabId;
    const institution = recordingTabs[tabId] || null;
    const count = institution ? (networkBuffer[institution] || []).length : 0;
    sendResponse({ recording: !!institution, institution, count });
    return true;
  }

  if (message.type === "CHECK_RECORDING_FOR_TAB") {
    // Content script asking on load if it should be recording
    const tabId = sender.tab?.id;
    const shouldRecord = tabId && tabId in recordingTabs;
    sendResponse({ shouldRecord: !!shouldRecord });
    return true;
  }
});
