/**
 * Recipe scraping — extract JSON-LD Recipe data from web pages.
 * Uses Playwright (headless Chromium) to bypass Cloudflare and other
 * bot-protection that blocks raw HTTP requests from datacenter IPs.
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser } from "playwright";

chromium.use(StealthPlugin());

interface Recipe {
  "@type"?: string;
  "@context"?: string;
  name?: string;
  url?: string;
  [key: string]: unknown;
}

interface WithGraph {
  "@graph"?: Recipe[];
  [key: string]: unknown;
}

// Reuse a single browser instance across requests
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function extractRecipes(ldBlocks: string[], url: string): Recipe[] {
  const recipes: Recipe[] = [];

  for (const text of ldBlocks) {
    let ldjson: unknown;
    try {
      ldjson = JSON.parse(text);
    } catch {
      continue;
    }

    // Unwrap @graph
    if (ldjson && typeof ldjson === "object" && "@graph" in (ldjson as WithGraph)) {
      ldjson = (ldjson as WithGraph)["@graph"];
    }

    const items = Array.isArray(ldjson) ? ldjson : [ldjson];
    for (const item of items) {
      if (isRecipe(item as Recipe)) {
        (item as Recipe).url = url;
        recipes.push(item as Recipe);
      }
    }
  }

  return recipes;
}

function isRecipe(item: Recipe): boolean {
  if (!item || typeof item !== "object") return false;
  if (!item["@type"]) return false;
  const type = Array.isArray(item["@type"]) ? item["@type"][0] : item["@type"];
  return type === "Recipe";
}

export async function scrapeRecipesFromUrl(url: string): Promise<Recipe[]> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Wait for Cloudflare challenge to resolve if present
    const title = await page.title();
    if (title.includes("Just a moment") || title.includes("Checking")) {
      await page.waitForFunction("!document.title.includes('Just a moment')", { timeout: 15_000 });
    }

    // Extract all ld+json script contents in the browser context
    const ldBlocks = await page.$$eval(
      'script[type="application/ld+json"]',
      (scripts) => scripts.map((s) => s.textContent || ""),
    );

    return extractRecipes(ldBlocks, url);
  } finally {
    await context.close();
  }
}
