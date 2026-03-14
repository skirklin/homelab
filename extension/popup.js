// Popup script for Money Data Collector extension.

const INSTITUTIONS = [
  { id: "ally", name: "Ally Bank", patterns: ["secure.ally.com", "wwws.ally.com"] },
  { id: "wealthfront", name: "Wealthfront", patterns: ["www.wealthfront.com"] },
  { id: "betterment", name: "Betterment", patterns: ["wwws.betterment.com"] },
  { id: "morgan_stanley", name: "Morgan Stanley", patterns: ["stockplanconnect.morganstanley.com", "www.morganstanley.com", "shareworks.solium.com"] },
  { id: "capital_one", name: "Capital One", patterns: ["myaccounts.capitalone.com", "www.capitalone.com"] },
  { id: "bofa", name: "Bank of America", patterns: ["secure.bankofamerica.com", "www.bankofamerica.com"] },
  { id: "chase", name: "Chase", patterns: ["secure.chase.com", "chase.com"] },
];

async function init() {
  await loadSettings();
  await checkServer();
  await renderInstitutions();
}

async function loadSettings() {
  const result = await chrome.storage.local.get(["serverPort", "profile"]);
  document.getElementById("portInput").value = result.serverPort || 5555;
  document.getElementById("profileInput").value = result.profile || "";

  document.getElementById("portInput").addEventListener("change", async (e) => {
    const newPort = parseInt(e.target.value, 10);
    if (newPort >= 1 && newPort <= 65535) {
      await chrome.storage.local.set({ serverPort: newPort });
      await checkServer();
    }
  });

  document.getElementById("profileInput").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ profile: e.target.value.trim() });
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
