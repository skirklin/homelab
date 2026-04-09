// Popup script for Money Data Collector extension.

const INSTITUTIONS = [
  { id: "ally", name: "Ally Bank", patterns: ["secure.ally.com", "wwws.ally.com"] },
  { id: "wealthfront", name: "Wealthfront", patterns: ["www.wealthfront.com"] },
  { id: "betterment", name: "Betterment", patterns: ["wwws.betterment.com"] },
  { id: "morgan_stanley", name: "Morgan Stanley", patterns: ["stockplanconnect.morganstanley.com", "www.morganstanley.com", "shareworks.solium.com"] },
  { id: "capital_one", name: "Capital One", patterns: ["myaccounts.capitalone.com", "www.capitalone.com"] },
  { id: "bofa", name: "Bank of America", patterns: ["secure.bankofamerica.com", "www.bankofamerica.com"] },
  { id: "chase", name: "Chase", patterns: ["secure.chase.com", "chase.com"] },
  { id: "fidelity", name: "Fidelity NetBenefits", patterns: ["nb.fidelity.com", "workplaceservices.fidelity.com"] },
];

async function init() {
  await loadSettings();
  await checkServer();
  await checkForUpdate();
  await renderInstitutions();
  await renderActivityLog();
}

async function renderActivityLog() {
  const container = document.getElementById("activityLog");
  const result = await chrome.storage.local.get("activityLog");
  const log = result.activityLog || [];

  if (log.length === 0) {
    container.innerHTML = '<div style="color: #aaa; padding: 4px 0;">No recent activity</div>';
    return;
  }

  container.innerHTML = log.map(entry => {
    const time = new Date(entry.time);
    const ago = timeAgo(time);
    return `<div style="padding: 2px 0; border-bottom: 1px solid #f0f0f0;">
      <span style="color: #aaa;">${ago}</span> ${entry.message}
    </div>`;
  }).join("");
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function loadSettings() {
  const result = await chrome.storage.local.get(["serverUrl", "profile"]);
  document.getElementById("serverUrlInput").value = result.serverUrl || "https://homelab-0.tail56ca88.ts.net:8443";
  document.getElementById("profileSelect").value = result.profile || "scott";

  document.getElementById("serverUrlInput").addEventListener("change", async (e) => {
    const url = e.target.value.trim();
    if (url) {
      await chrome.storage.local.set({ serverUrl: url });
      await checkServer();
    }
  });

  document.getElementById("profileSelect").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ profile: e.target.value });
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

async function checkForUpdate() {
  const banner = document.getElementById("updateBanner");
  try {
    const result = await chrome.storage.local.get("serverUrl");
    const baseUrl = (result.serverUrl || "https://homelab-0.tail56ca88.ts.net:8443").replace(/\/+$/, "");
    const resp = await fetch(`${baseUrl}/extension/version`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    const data = await resp.json();
    const manifest = chrome.runtime.getManifest();
    if (data.version && data.version !== manifest.version && data.available) {
      banner.style.display = "block";
      banner.textContent = `Update available: v${data.version} (you have v${manifest.version}). Click to download.`;
      banner.onclick = () => {
        chrome.tabs.create({ url: `${baseUrl}/extension/download` });
      };
    }
  } catch {
    // Server not available or no extension hosted — that's fine
  }
}

async function renderInstitutions() {
  const container = document.getElementById("institutions");
  container.innerHTML = "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tab?.url || "";

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
    const div = document.createElement("div");
    div.className = "institution";

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
    } catch (e) {}

    div.innerHTML = `
      <div class="inst-header">
        <span class="inst-name">${inst.name}</span>
        <span class="inst-status detected">On page</span>
      </div>
      <div class="btn-row">
        <button class="cookie-btn" id="cookies-${inst.id}"
          title="Capture session cookies">
          Cookies
        </button>
        <button class="record-btn ${isRecording ? "recording" : ""}" id="record-${inst.id}"
          title="Record network requests (captures API calls + responses)">
          ${isRecording ? `Stop (${recordCount})` : "Record"}
        </button>
      </div>
      <div class="sync-result" id="result-${inst.id}"></div>
    `;

    container.appendChild(div);

    document.getElementById(`cookies-${inst.id}`).addEventListener("click", () =>
      captureCookies(inst.id, document.getElementById(`cookies-${inst.id}`))
    );

    document.getElementById(`record-${inst.id}`).addEventListener("click", () =>
      toggleRecording(inst.id, tab.id, document.getElementById(`record-${inst.id}`), isRecording)
    );
  }
}

async function captureCookies(institutionId, btn) {
  btn.disabled = true;
  btn.textContent = "...";

  const resultEl = document.getElementById(`result-${institutionId}`);
  const response = await chrome.runtime.sendMessage({
    type: "CAPTURE_COOKIES",
    institution: institutionId,
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
    const response = await chrome.runtime.sendMessage({
      type: "START_NETWORK_RECORDING",
      tabId,
      institution: institutionId,
    });

    if (response.started) {
      btn.textContent = "Stop (0)";
      btn.className = "record-btn recording";
      resultEl.textContent = "Recording... browse the site, then click Stop";
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
