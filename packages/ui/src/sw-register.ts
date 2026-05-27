/**
 * Service worker registration + auto-update lifecycle.
 *
 * Registers the SW that vite-plugin-pwa builds at `/sw.js` (idempotent —
 * the browser dedupes by scope/scriptURL) and wires up the pieces that
 * keep installed PWAs from drifting onto stale bundles:
 *
 *  - Periodic update probe (every 5 min) so a long-running tab notices
 *    new deployments without a navigation event. Tighter than the old
 *    30-min interval because deploys can land any time and the stale
 *    window between deploy and detection is when the "click a link →
 *    NotFound" footgun fires (a deploy that renamed/removed a route
 *    has the old shell still routing the click for up to the probe
 *    interval). 5 min is cheap (one HTTP HEAD-equivalent per tab) and
 *    meaningfully shrinks that window.
 *  - Update probe on tab focus, so phones picked back up after a deploy
 *    refresh promptly instead of waiting out the probe interval.
 *  - "Update available" signal (`useUpdateAvailable`) that fires the
 *    moment the browser finds an installing SW (`updatefound`), so the
 *    UI can surface a banner inviting the user to reload. This catches
 *    the *active* user — someone interacting with the page during the
 *    install→activate window, who would otherwise click a link before
 *    `controllerchange` fires and get a stale-shell NotFound.
 *  - Auto-reload when a newly-activated SW takes control of the page.
 *    vite-plugin-pwa's autoUpdate strategy bakes in skipWaiting +
 *    clientsClaim, so a new SW grabs control as soon as it activates;
 *    we reload so the page stops executing the stale bundle that's
 *    paired with a now-replaced cache. This catches the *idle* user:
 *    they were AFK while the SW installed and activated, and the next
 *    interaction will be on the fresh bundle.
 *
 * Skipped in dev (the plugin is configured with devOptions.enabled = false)
 * and in jsdom-based tests where `navigator.serviceWorker` is undefined.
 */
import { useEffect, useState } from "react";

const SW_PATH = "/sw.js";
const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

let registered = false;

// Tiny event-emitter so `useUpdateAvailable` can subscribe without React state
// here. Module-scoped so multiple BackendProvider mounts (or HMR) all observe
// the same value.
let updateAvailable = false;
const updateListeners = new Set<(v: boolean) => void>();
function setUpdateAvailable(v: boolean): void {
  if (updateAvailable === v) return;
  updateAvailable = v;
  for (const fn of updateListeners) fn(v);
}

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

    // "Update available" — fires when the browser detects a new SW script
    // and starts installing it. Gated by `hadController` for the same
    // reason as the reload above: a first-install isn't an "update."
    // The signal is consumed by <UpdateAvailableBanner /> via
    // `useUpdateAvailable()` to prompt the user to reload onto the new
    // bundle before they hit a stale-route footgun.
    const onUpdateFound = () => {
      if (!hadController) return;
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // "installed" means the new SW is ready and waiting (or, with
        // clientsClaim, about to activate). Either way, the user's
        // current page is now provably running the OLD bundle and a
        // fresh build exists.
        if (installing.state === "installed") setUpdateAvailable(true);
      });
    };
    reg.addEventListener("updatefound", onUpdateFound);
    // If a waiting worker is already present at registration time
    // (e.g. the user came back to a tab whose SW updated in
    // background), surface the banner immediately.
    if (hadController && reg.waiting) setUpdateAvailable(true);
  }).catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
}

/**
 * Subscribes to "update available" state. Returns `true` after the browser
 * has finished installing a new service worker for this page — i.e. there's
 * a newer build than the one currently running. Pair with a banner /
 * `location.reload()` to let the user opt into the new bundle.
 */
export function useUpdateAvailable(): boolean {
  const [v, setV] = useState<boolean>(updateAvailable);
  useEffect(() => {
    // Sync in case the module-scoped flag flipped between render and effect.
    setV(updateAvailable);
    updateListeners.add(setV);
    return () => {
      updateListeners.delete(setV);
    };
  }, []);
  return v;
}

/** Test-only reset. Not exported from the package barrel. */
export function __resetSwRegisterForTests(): void {
  registered = false;
  updateAvailable = false;
  updateListeners.clear();
}

/** Test-only setter so unit tests can drive the subscriber path without a SW. */
export function __setUpdateAvailableForTests(v: boolean): void {
  setUpdateAvailable(v);
}
