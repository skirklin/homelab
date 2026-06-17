// Content extractor — injected into the active tab via
// chrome.scripting.executeScript. MUST be fully self-contained: it runs in
// the page's isolated world with no access to the popup's scope.
//
// Ports services/api/src/lib/scraper.ts extractRecipes/isRecipe: read every
// <script type="application/ld+json"> block, parse it, unwrap @graph, and
// return each object whose @type is (or includes) "Recipe". Returns the raw
// JSON-LD Recipe objects verbatim — the recipes app stores them as-is.
function extractRecipesFromPage() {
  function isRecipe(item) {
    if (!item || typeof item !== "object") return false;
    if (!item["@type"]) return false;
    const type = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
    return type.includes("Recipe");
  }

  const recipes = [];
  const blocks = document.querySelectorAll('script[type="application/ld+json"]');

  for (const block of blocks) {
    let ldjson;
    try {
      ldjson = JSON.parse(block.textContent || "");
    } catch {
      continue;
    }

    // Unwrap @graph
    if (ldjson && typeof ldjson === "object" && "@graph" in ldjson) {
      ldjson = ldjson["@graph"];
    }

    const items = Array.isArray(ldjson) ? ldjson : [ldjson];
    for (const item of items) {
      if (isRecipe(item)) {
        if (!item.url) item.url = location.href;
        recipes.push(item);
      }
    }
  }

  return recipes;
}
