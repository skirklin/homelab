// Popup script for Money Data Collector extension.

const INSTITUTIONS = [
  { id: "ally", name: "Ally Bank", patterns: ["secure.ally.com", "wwws.ally.com"] },
  { id: "wealthfront", name: "Wealthfront", patterns: ["www.wealthfront.com"] },
  { id: "betterment", name: "Betterment", patterns: ["wwws.betterment.com"] },
];

async function init() {
  await loadPort();
  await checkServer();
  await renderInstitutions();
}

async function loadPort() {
  const result = await chrome.storage.local.get("serverPort");
  const port = result.serverPort || 5555;
  document.getElementById("portInput").value = port;

  document.getElementById("portInput").addEventListener("change", async (e) => {
    const newPort = parseInt(e.target.value, 10);
    if (newPort >= 1 && newPort <= 65535) {
      await chrome.storage.local.set({ serverPort: newPort });
      await checkServer();
    }
  });
}

async function checkServer() {
  const response = await chrome.runtime.sendMessage({ type: "CHECK_HEALTH" });
  const dot = document.getElementById("serverStatus");
  const label = document.getElementById("serverLabel");

  if (response.healthy) {
    dot.className = "status-dot connected";
    label.textContent = "Server connected";
  } else {
    dot.className = "status-dot disconnected";
    label.textContent = "Server not running (money serve)";
  }
}

async function renderInstitutions() {
  const container = document.getElementById("institutions");
  container.innerHTML = "";

  // Get the current active tab to detect which institution we're on
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tab?.url || "";

  // Only show the institution that matches the current tab
  const detected = INSTITUTIONS.filter((inst) =>
    inst.patterns.some((p) => currentUrl.includes(p))
  );

  if (detected.length === 0) {
    container.innerHTML = `
      <div style="padding: 20px 16px; text-align: center; color: #999; font-size: 12px;">
        Navigate to a supported financial site to collect data.
      </div>
    `;
    return;
  }

  for (const inst of detected) {
    const isDetected = true;

    const div = document.createElement("div");
    div.className = "institution";

    // Check for scraped data
    const scraped = await chrome.runtime.sendMessage({
      type: "GET_SCRAPED",
      institution: inst.id,
    });

    const hasData = scraped && scraped.data && Date.now() - scraped.timestamp < 300000;
    const accountsHtml = hasData ? renderAccounts(scraped.data) : "";

    const statusClass = isDetected ? "detected" : "";
    const statusText = isDetected ? "On page" : hasData ? "Data ready" : "Not detected";

    // Check recording status for this tab
    let isRecording = false;
    let recordCount = 0;
    try {
      const recordStatus = await chrome.runtime.sendMessage({
        type: "GET_RECORDING_STATUS",
        tabId: tab?.id,
      });
      if (recordStatus) {
        isRecording = recordStatus.recording && recordStatus.institution === inst.id;
        recordCount = isRecording ? recordStatus.count : 0;
      }
    } catch (e) {
      // Background script may not support this yet
    }

    div.innerHTML = `
      <div class="inst-header">
        <span class="inst-name">${inst.name}</span>
        <span class="inst-status ${statusClass}">${statusText}</span>
      </div>
      ${accountsHtml}
      <div class="btn-row">
        <button class="sync-btn" id="sync-${inst.id}"
          ${!hasData && !isDetected ? "disabled" : ""}>
          ${isDetected && !hasData ? "Scrape Page" : hasData ? "Send to Server" : "Visit site to collect"}
        </button>
        <button class="cookie-btn" id="cookies-${inst.id}"
          ${!isDetected ? "disabled" : ""} title="Capture session cookies for automated sync">
          Cookies
        </button>
        <button class="record-btn ${isRecording ? "recording" : ""}" id="record-${inst.id}"
          ${!isDetected ? "disabled" : ""} title="Record network requests for API discovery">
          ${isRecording ? `Stop (${recordCount})` : "Record"}
        </button>
      </div>
      <div class="sync-result" id="result-${inst.id}"></div>
    `;

    container.appendChild(div);

    // Set up button handlers
    const btn = document.getElementById(`sync-${inst.id}`);
    if (isDetected && !hasData) {
      btn.addEventListener("click", () => scrapeCurrentPage(inst.id, tab.id, btn));
    } else if (hasData) {
      btn.addEventListener("click", () => sendToServer(inst.id, scraped.data, btn));
    }

    const cookieBtn = document.getElementById(`cookies-${inst.id}`);
    if (isDetected) {
      cookieBtn.addEventListener("click", () => captureCookies(inst.id, cookieBtn));
    }

    const recordBtn = document.getElementById(`record-${inst.id}`);
    if (isDetected) {
      recordBtn.addEventListener("click", () =>
        toggleRecording(inst.id, tab.id, recordBtn, isRecording)
      );
    }
  }
}

function renderAccounts(data) {
  if (!data.accounts || data.accounts.length === 0) return "";

  const rows = data.accounts
    .map((a) => {
      const bal = a.balance != null ? `$${Number(a.balance).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "---";
      const extId = a.external_id ? ` ••${a.external_id}` : "";
      return `<div class="account-row">
        <span class="account-name">${a.name}${extId}</span>
        <span class="account-balance">${bal}</span>
      </div>`;
    })
    .join("");

  return `<div class="accounts">${rows}</div>`;
}

async function scrapeCurrentPage(institutionId, tabId, btn) {
  btn.disabled = true;
  btn.textContent = "Scraping...";

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE" });
    if (response && response.success) {
      btn.textContent = "Send to Server";
      btn.disabled = false;
      btn.className = "sync-btn";
      // Re-render to show the accounts
      await renderInstitutions();
    } else {
      btn.textContent = "Scrape failed";
      btn.className = "sync-btn error";
      const resultEl = document.getElementById(`result-${institutionId}`);
      resultEl.textContent = response?.error || "Unknown error";
    }
  } catch (err) {
    btn.textContent = "Scrape failed";
    btn.className = "sync-btn error";
    const resultEl = document.getElementById(`result-${institutionId}`);
    resultEl.textContent = err.message;
  }
}

async function sendToServer(institutionId, data, btn) {
  btn.disabled = true;
  btn.textContent = "Sending...";

  const response = await chrome.runtime.sendMessage({
    type: "SYNC_DATA",
    payload: data,
  });

  const resultEl = document.getElementById(`result-${institutionId}`);

  if (response.success) {
    btn.textContent = "Sent!";
    btn.className = "sync-btn success";
    const r = response.data;
    resultEl.textContent = `${r.accounts_synced || 0} account(s), ${r.balances_recorded || 0} balance(s)`;

    // Clear the stored scraped data
    await chrome.storage.local.remove(`scraped_${institutionId}`);
  } else {
    btn.textContent = "Failed";
    btn.className = "sync-btn error";
    resultEl.textContent = response.error;
  }
}

async function captureCookies(institutionId, btn) {
  btn.disabled = true;
  btn.textContent = "...";

  const profile = document.getElementById("profileInput").value.trim() || undefined;
  const resultEl = document.getElementById(`result-${institutionId}`);
  const response = await chrome.runtime.sendMessage({
    type: "CAPTURE_COOKIES",
    institution: institutionId,
    profile,
  });

  if (response.success) {
    btn.textContent = "Sent!";
    btn.className = "cookie-btn success";
    resultEl.textContent = `${response.count} cookie(s) captured`;
  } else {
    btn.textContent = "Failed";
    btn.className = "cookie-btn error";
    resultEl.textContent = response.error;
  }
}

async function toggleRecording(institutionId, tabId, btn, isCurrentlyRecording) {
  const resultEl = document.getElementById(`result-${institutionId}`);

  if (isCurrentlyRecording) {
    // Stop recording and send captured data
    btn.disabled = true;
    btn.textContent = "Sending...";

    const response = await chrome.runtime.sendMessage({
      type: "STOP_NETWORK_RECORDING",
      tabId,
      institution: institutionId,
    });

    if (response.success) {
      btn.textContent = "Done!";
      btn.className = "record-btn success";
      resultEl.textContent = `${response.count} request(s) sent to server`;
    } else {
      btn.textContent = "Failed";
      btn.className = "record-btn";
      resultEl.textContent = response.error;
    }
  } else {
    // Start recording
    const response = await chrome.runtime.sendMessage({
      type: "START_NETWORK_RECORDING",
      tabId,
      institution: institutionId,
    });

    if (response.started) {
      btn.textContent = "Stop (0)";
      btn.className = "record-btn recording";
      resultEl.textContent = "Recording network requests... browse the site, then click Stop";
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
