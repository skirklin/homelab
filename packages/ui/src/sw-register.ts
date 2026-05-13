/**
 * Service worker registration + auto-update lifecycle.
 *
 * Registers the SW that vite-plugin-pwa builds at `/sw.js` (idempotent —
 * the browser dedupes by scope/scriptURL) and wires up the pieces that
 * keep installed PWAs from drifting onto stale bundles:
 *
 *  - Periodic update probe (every 30 min) so a long-running tab notices
 *    new deployments without a navigation event.
 *  - Update probe on tab focus, so phones picked back up after a deploy
 *    refresh promptly instead of waiting out the 30-min interval.
 *  - Auto-reload when a newly-activated SW takes control of the page.
 *    vite-plugin-pwa's autoUpdate strategy bakes in skipWaiting +
 *    clientsClaim, so a new SW grabs control as soon as it activates;
 *    we reload so the page stops executing the stale bundle that's
 *    paired with a now-replaced cache.
 *
 * Skipped in dev (the plugin is configured with devOptions.enabled = false)
 * and in jsdom-based tests where `navigator.serviceWorker` is undefined.
 */

const SW_PATH = "/sw.js";
const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

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

  // Snapshot whether the page was already SW-controlled. The first time a
  // user installs the PWA, controllerchange fires once when the brand-new
  // SW grabs the previously-uncontrolled page — we don't want to reload
  // then, because the bundle is fresh. On subsequent visits the page comes
  // up already-controlled, and a later controllerchange means the SW has
  // swapped to a newer version while we were running.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.register(SW_PATH).then((reg) => {
    const probe = () => { reg.update().catch(() => { /* offline or network blip */ }); };
    setInterval(probe, UPDATE_INTERVAL_MS);
    // Pageshow + focus together cover phones returning from background
    // (focus alone misses bfcache restores on iOS).
    window.addEventListener("focus", probe);
    window.addEventListener("pageshow", probe);
  }).catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
}
