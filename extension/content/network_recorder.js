// Network recorder — injected into institution pages to capture API requests.
// Uses an external script file to bypass CSP inline restrictions.

let recording = false;

function startRecording() {
  if (recording) return;
  recording = true;

  // Inject the interceptor as an external script (CSP allows extension scripts)
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("content/page_interceptor.js");
  document.documentElement.appendChild(script);
}

function stopRecording() {
  recording = false;
}

function safeSendMessage(msg) {
  try {
    if (!chrome.runtime?.id) return; // Extension context invalidated
    chrome.runtime.sendMessage(msg);
  } catch (e) {
    // Extension was reloaded or uninstalled — ignore
  }
}

// Relay intercepted requests from page context to background
window.addEventListener("message", (event) => {
  if (event.data && event.data.source === "__money_network") {
    safeSendMessage({
      type: "NETWORK_REQUEST",
      entry: event.data.entry,
    });
  }
  if (event.data && event.data.source === "__money_auth_token") {
    safeSendMessage({
      type: "AUTH_TOKEN",
      token: event.data.token,
      tokenType: event.data.tokenType,
      expiresIn: event.data.expiresIn,
    });
  }
});

// Listen for start/stop commands from popup via background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_RECORDING") {
    startRecording();
    sendResponse({ started: true });
    return true;
  }
  if (message.type === "STOP_RECORDING") {
    stopRecording();
    sendResponse({ stopped: true });
    return true;
  }
});

// On load, check if background says we should be recording (survives page refresh)
try {
  chrome.runtime.sendMessage({ type: "CHECK_RECORDING_FOR_TAB" }, (response) => {
    if (chrome.runtime.lastError) return; // Stale context
    if (response && response.shouldRecord) {
      startRecording();
    }
  });
} catch (e) {
  // Extension context invalidated — ignore
}
