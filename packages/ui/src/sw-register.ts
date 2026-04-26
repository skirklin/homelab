/**
 * Service worker registration.
 *
 * Registers the SW that vite-plugin-pwa builds at `/sw.js`. Idempotent —
 * the browser dedupes registrations by scope/scriptURL.
 *
 * Skipped in dev (the plugin is configured with devOptions.enabled = false)
 * and in jsdom-based tests where `navigator.serviceWorker` is undefined.
 */

const SW_PATH = "/sw.js";

let registered = false;

export function registerServiceWorker(): void {
  if (registered) return;
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  // Vite sets import.meta.env.DEV in dev mode. The PWA plugin is disabled
  // in dev, so registering would 404. Use a runtime check rather than a
  // build-time one so this module is consumable from non-Vite contexts.
  if (location.hostname === "localhost" && location.port && location.port !== "") {
    // Best-effort skip for vite dev server; production builds serve /sw.js.
    return;
  }
  registered = true;
  navigator.serviceWorker.register(SW_PATH).catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
}
