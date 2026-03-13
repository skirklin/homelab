// Background service worker for Money Data Collector extension.
// Receives data from content scripts and forwards to the local server.

const DEFAULT_PORT = 5555;

// Cookie domains per institution
const COOKIE_DOMAINS = {
  ally: [".ally.com", "secure.ally.com", "wwws.ally.com"],
  wealthfront: [".wealthfront.com", "www.wealthfront.com"],
  betterment: [".betterment.com", "wwws.betterment.com"],
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
    const response = await fetch(`${baseUrl}/health`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function captureCookies(institution, profile) {
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
  if (profile) payload.profile = profile;

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

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SYNC_DATA") {
    sendToServer("/ingest", message.payload).then(sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.type === "CHECK_HEALTH") {
    checkServerHealth().then((healthy) => sendResponse({ healthy }));
    return true;
  }

  if (message.type === "SCRAPED_DATA") {
    // Store scraped data from content script for popup to retrieve
    chrome.storage.local.set({
      [`scraped_${message.institution}`]: {
        data: message.payload,
        timestamp: Date.now(),
        tabId: sender.tab?.id,
      },
    });
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "GET_SCRAPED") {
    chrome.storage.local.get(`scraped_${message.institution}`).then((result) => {
      sendResponse(result[`scraped_${message.institution}`] || null);
    });
    return true;
  }

  if (message.type === "CAPTURE_COOKIES") {
    captureCookies(message.institution, message.profile).then(sendResponse);
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
