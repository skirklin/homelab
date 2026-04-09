import { Hono } from "hono";
import { scrapeRecipesFromUrl } from "../lib/scraper";
import { handler } from "../lib/handler";

export const recipesRoutes = new Hono();

/** Validate URL is safe to fetch — block SSRF vectors */
function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL";
  }

  // Only allow http/https
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Only http and https URLs are allowed";
  }

  // Block internal/private hostnames
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".svc.cluster.local") ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254"
  ) {
    return "Internal URLs are not allowed";
  }

  // Block private/reserved IPv4 ranges
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    if (
      parts[0] === 0 ||   // 0.0.0.0/8 — "this" network
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) // CGNAT
    ) {
      return "Private IP addresses are not allowed";
    }
  }

  // Block IPv6 private/reserved (bracketed in URLs)
  if (hostname.startsWith("[")) {
    return "IPv6 addresses are not allowed";
  }

  return null;
}

recipesRoutes.post("/scrape", handler(async (c) => {
  const { url } = await c.req.json<{ url: string }>();

  if (!url || typeof url !== "string" || !url.trim()) {
    return c.json({ error: "Must specify a valid URL" }, 400);
  }

  const urlError = validateUrl(url.trim());
  if (urlError) {
    return c.json({ error: urlError }, 400);
  }

  const recipes = await scrapeRecipesFromUrl(url.trim());
  return c.json({ recipes });
}));
