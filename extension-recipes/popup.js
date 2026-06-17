const DEFAULT_BASE = "https://api.kirkl.in";

let recipes = []; // raw JSON-LD Recipe objects found on the page

async function getConfig() {
  const { apiBaseUrl, apiToken } = await chrome.storage.sync.get(["apiBaseUrl", "apiToken"]);
  return {
    baseUrl: (apiBaseUrl || DEFAULT_BASE).replace(/\/+$/, ""),
    token: apiToken || "",
  };
}

function setStatus(text, kind) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function recipeName(r) {
  if (typeof r.name === "string" && r.name.trim()) return r.name.trim();
  return "Untitled recipe";
}

// Inject the extractor into the active tab and return the recipes it finds.
async function extractFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab");
  // Load the extractor (defines extractRecipesFromPage in the page's isolated
  // world), then call it in a second injection so we get its return value.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["extract.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => extractRecipesFromPage(),
  });
  return (results && results[0] && results[0].result) || [];
}

async function fetchBoxes(cfg) {
  const resp = await fetch(`${cfg.baseUrl}/fn/data/boxes`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (resp.status === 401) throw { code: 401 };
  if (!resp.ok) throw { code: resp.status };
  return resp.json();
}

function renderRecipeOptions() {
  const sel = document.getElementById("recipeSelect");
  sel.innerHTML = "";
  recipes.forEach((r, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = recipeName(r);
    sel.appendChild(opt);
  });
  // Hide the recipe dropdown when there's only one.
  sel.parentElement.querySelector('label[for="recipeSelect"]').style.display =
    recipes.length > 1 ? "block" : "none";
  sel.style.display = recipes.length > 1 ? "block" : "none";
}

function renderBoxOptions(boxes) {
  const sel = document.getElementById("boxSelect");
  sel.innerHTML = "";
  boxes.forEach((b) => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name || b.id;
    sel.appendChild(opt);
  });
}

async function doImport() {
  const cfg = await getConfig();
  const btn = document.getElementById("importBtn");
  const recipeIdx = Number(document.getElementById("recipeSelect").value);
  const boxId = document.getElementById("boxSelect").value;
  const data = recipes[recipeIdx];
  if (!boxId || !data) return;

  btn.disabled = true;
  setStatus("Importing…");
  try {
    const resp = await fetch(`${cfg.baseUrl}/fn/data/recipes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ boxId, data }),
    });
    if (resp.status === 401) {
      setStatus("Unauthorized — check your API token in Options.", "error");
      btn.disabled = false;
      return;
    }
    if (resp.status === 403) {
      setStatus("Access denied to that box.", "error");
      btn.disabled = false;
      return;
    }
    if (!resp.ok) {
      setStatus(`Import failed (HTTP ${resp.status}).`, "error");
      btn.disabled = false;
      return;
    }
    const body = await resp.json();
    setStatus(`Saved "${body.name || recipeName(data)}".`, "success");
    document.getElementById("picker").style.display = "none";
  } catch (e) {
    setStatus("Network error — is the server reachable?", "error");
    btn.disabled = false;
  }
}

async function init() {
  const cfg = await getConfig();
  if (!cfg.token) {
    setStatus("");
    const el = document.getElementById("status");
    el.innerHTML =
      'No API token configured. <span class="link" id="openOpts">Open Options</span> to add one.';
    el.querySelector("#openOpts").addEventListener("click", () =>
      chrome.runtime.openOptionsPage(),
    );
    return;
  }

  // 1) Extract recipes from the page.
  try {
    recipes = await extractFromActiveTab();
  } catch (e) {
    setStatus("Can't read this page (try a normal http/https page).", "error");
    return;
  }
  if (recipes.length === 0) {
    setStatus("No recipe detected on this page.");
    return;
  }

  // 2) Load the user's boxes.
  let boxes;
  try {
    boxes = await fetchBoxes(cfg);
  } catch (e) {
    if (e && e.code === 401) {
      const el = document.getElementById("status");
      el.className = "msg error";
      el.innerHTML =
        'Unauthorized. <span class="link" id="openOpts">Check your API token in Options.</span>';
      el.querySelector("#openOpts").addEventListener("click", () =>
        chrome.runtime.openOptionsPage(),
      );
      return;
    }
    setStatus("Couldn't load your recipe boxes (network or server error).", "error");
    return;
  }
  if (!boxes.length) {
    setStatus("You have no recipe boxes. Create one at kirkl.in first.", "error");
    return;
  }

  // 3) Render the picker.
  const count = recipes.length;
  setStatus(count === 1 ? `Found: ${recipeName(recipes[0])}` : `Found ${count} recipes.`);
  renderRecipeOptions();
  renderBoxOptions(boxes);
  document.getElementById("picker").style.display = "block";
  document.getElementById("importBtn").addEventListener("click", doImport);
}

document.addEventListener("DOMContentLoaded", init);
