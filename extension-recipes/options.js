const DEFAULT_BASE = "https://api.kirkl.in";

function setStatus(text, kind) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = kind || "";
}

function baseUrl() {
  return (document.getElementById("apiBaseUrl").value.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

async function load() {
  const { apiBaseUrl, apiToken } = await chrome.storage.sync.get(["apiBaseUrl", "apiToken"]);
  document.getElementById("apiBaseUrl").value = apiBaseUrl || DEFAULT_BASE;
  document.getElementById("apiToken").value = apiToken || "";
}

async function save() {
  const apiToken = document.getElementById("apiToken").value.trim();
  await chrome.storage.sync.set({ apiBaseUrl: baseUrl(), apiToken });
  setStatus("Saved.", "ok");
}

async function test() {
  const token = document.getElementById("apiToken").value.trim();
  if (!token) {
    setStatus("Enter an API token first.", "err");
    return;
  }
  setStatus("Testing…");
  try {
    const resp = await fetch(`${baseUrl()}/fn/data/boxes`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 401) {
      setStatus("Failed: token rejected (401). Check the token.", "err");
      return;
    }
    if (!resp.ok) {
      setStatus(`Failed: HTTP ${resp.status}.`, "err");
      return;
    }
    const boxes = await resp.json();
    setStatus(`OK — ${boxes.length} recipe box${boxes.length === 1 ? "" : "es"} reachable.`, "ok");
  } catch (e) {
    setStatus("Failed: could not reach the server.", "err");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  document.getElementById("saveBtn").addEventListener("click", save);
  document.getElementById("testBtn").addEventListener("click", test);
});
