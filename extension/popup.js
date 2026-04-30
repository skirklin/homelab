const INSTITUTIONS = [
  { id: "ally", name: "Ally Bank", patterns: ["secure.ally.com"] },
  { id: "wealthfront", name: "Wealthfront", patterns: ["www.wealthfront.com"] },
  { id: "betterment", name: "Betterment", patterns: ["wwws.betterment.com"] },
  { id: "morgan_stanley", name: "Morgan Stanley", patterns: ["shareworks.solium.com"] },
  { id: "capital_one", name: "Capital One", patterns: ["myaccounts.capitalone.com"] },
  { id: "chase", name: "Chase", patterns: ["secure.chase.com"] },
  { id: "fidelity", name: "Fidelity", patterns: ["workplaceservices.fidelity.com"] },
];

async function init() {
  await loadSettings();
  await checkServer();
  await checkForUpdate();
  renderDetected();
  renderActivityLog();
  initManualRecord();
}

function initManualRecord() {
  const btn = document.getElementById("manualToggle");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const status = await chrome.runtime.sendMessage({ type: "MANUAL_STATUS" });
    if (status?.active) {
      const r = await chrome.runtime.sendMessage({ type: "MANUAL_STOP" });
      if (!r?.ok) alert(`Stop failed: ${r?.error || "unknown"}`);
    } else {
      const r = await chrome.runtime.sendMessage({ type: "MANUAL_START" });
      if (!r?.ok) alert(`Start failed: ${r?.error || "unknown"}`);
    }
    btn.disabled = false;
    await refreshManualStatus();
    await renderActivityLog();
  });
  refreshManualStatus();
  setInterval(refreshManualStatus, 1000);
}

async function refreshManualStatus() {
  const wrap = document.getElementById("manualRecord");
  const label = document.getElementById("manualStatus");
  const btn = document.getElementById("manualToggle");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSupportedSite = !!INSTITUTIONS.find(i => i.patterns.some(p => (tab?.url || "").includes(p)));
  const status = await chrome.runtime.sendMessage({ type: "MANUAL_STATUS" });

  // Show the panel whenever recording is active (so user can stop) or when
  // they're on a supported site (so they can start).
  if (!onSupportedSite && !status?.active) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "block";

  if (status?.active) {
    const seconds = Math.floor((Date.now() - status.startedAt) / 1000);
    label.textContent = `Recording ${status.institution} • ${status.entries} entries • ${seconds}s`;
    label.style.color = "#dc2626";
    btn.textContent = "Stop & upload";
    btn.style.background = "#dc2626";
  } else {
    label.textContent = "Idle — click Start, then navigate";
    label.style.color = "#666";
    btn.textContent = "Start";
    btn.style.background = "#1a1a2e";
  }
}

async function loadSettings() {
  const result = await chrome.storage.local.get(["serverUrl"]);
  document.getElementById("serverUrlInput").value = result.serverUrl || "https://homelab-0.tail56ca88.ts.net:8443";
  document.getElementById("serverUrlInput").addEventListener("change", async (e) => {
    const url = e.target.value.trim();
    if (url) {
      await chrome.storage.local.set({ serverUrl: url });
      await checkServer();
    }
  });
}

async function checkServer() {
  const response = await chrome.runtime.sendMessage({ type: "CHECK_HEALTH" });
  const dot = document.getElementById("serverStatus");
  const label = document.getElementById("serverLabel");
  dot.className = response.healthy ? "status-dot connected" : "status-dot disconnected";
  label.textContent = response.healthy ? "Connected" : "Not connected";
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
      banner.textContent = `Update available: v${data.version} (you have v${manifest.version})`;
      banner.onclick = () => chrome.tabs.create({ url: `${baseUrl}/extension/download` });
    }
  } catch {}
}

async function renderDetected() {
  const container = document.getElementById("institutions");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";

  const detected = INSTITUTIONS.filter(i => i.patterns.some(p => url.includes(p)));
  if (detected.length === 0) {
    container.innerHTML = '<div style="padding: 16px; text-align: center; color: #999; font-size: 12px;">Navigate to a bank site to capture data automatically.</div>';
    return;
  }

  container.innerHTML = detected.map(i =>
    `<div class="institution"><span class="inst-name">${i.name}</span><span class="inst-status detected">Capturing</span></div>`
  ).join("");
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
    const seconds = Math.floor((Date.now() - new Date(entry.time).getTime()) / 1000);
    const ago = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m` : seconds < 86400 ? `${Math.floor(seconds/3600)}h` : `${Math.floor(seconds/86400)}d`;
    return `<div style="padding: 2px 0; border-bottom: 1px solid #f0f0f0;"><span style="color: #aaa;">${ago}</span> ${entry.message}</div>`;
  }).join("");
}

document.addEventListener("DOMContentLoaded", init);
