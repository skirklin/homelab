/**
 * Shared Vite preset for kirkl.in apps.
 *
 * Authored as plain ESM (.mjs) so vite.config.ts in each app can import it
 * directly — Node loads vite configs natively and won't run TS through
 * esbuild for cross-package imports.
 */
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * @typedef {Object} KirklPluginsOptions
 * @property {string} name
 * @property {string} shortName
 * @property {string} [themeColor]
 * @property {string} [backgroundColor]
 * @property {string} [startUrl]
 * @property {Array<{src:string,sizes:string,type:string,purpose?:string}>} [icons]
 * @property {string[]} [importScripts]
 * @property {boolean} [autoUpdate]
 */

/** @param {KirklPluginsOptions} opts */
export function kirklPlugins(opts) {
  const {
    name,
    shortName,
    themeColor = "#ffffff",
    backgroundColor = "#ffffff",
    startUrl = "/",
    icons = [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
    importScripts = [],
    autoUpdate = true,
  } = opts;

  return [
    react(),
    VitePWA({
      registerType: autoUpdate ? "autoUpdate" : "prompt",
      injectRegister: null,
      includeAssets: ["favicon.ico", "favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name,
        short_name: shortName,
        start_url: startUrl,
        scope: "/",
        display: "standalone",
        background_color: backgroundColor,
        theme_color: themeColor,
        icons,
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        // Home bundles every sub-app, so individual chunks can clear 2 MB.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        importScripts,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/fn\//, /^\/api\//],
        runtimeCaching: [
          {
            // GET to /api/ or /fn/, but ABSOLUTELY NOT EventSource.
            //
            // workbox buffers the entire response before serving — fine for
            // normal JSON, fatal for SSE. PocketBase opens its realtime
            // channel at /api/realtime with an `Accept: text/event-stream`
            // header; if workbox intercepts that, the stream never
            // establishes and the client thinks realtime is permanently
            // down (Angela's 2026-05-19 bug — hard refresh bypasses the SW
            // and works; plain refresh installs the SW and SSE breaks until
            // the SW is unregistered). The path + Accept-header carve-out
            // below is belt + suspenders to keep SSE clear of the cache.
            //
            // NetworkFirst (rather than StaleWhileRevalidate) because these
            // endpoints serve mutable per-user data — checking off a
            // shopping item then refreshing within seconds previously
            // showed the pre-check snapshot from cache, then took a second
            // refresh to reflect the write. NetworkFirst always returns the
            // fresh response when online; the cache only fires on network
            // failure / timeout, preserving offline behavior.
            // networkTimeoutSeconds=3 caps the wait on a slow network
            // before falling back to cache.
            urlPattern: ({ url, request }) => {
              if (request.method !== "GET") return false;
              if (!(url.pathname.startsWith("/fn/") || url.pathname.startsWith("/api/"))) return false;
              // Belt + suspenders — match by path AND Accept header.
              if (url.pathname === "/api/realtime") return false;
              if ((request.headers.get("accept") || "").includes("text/event-stream")) return false;
              return true;
            },
            handler: "NetworkFirst",
            options: {
              cacheName: "kirkl-api",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // ONLY cache fonts.gstatic.com — static font binaries that are
            // safe to keep around for a month.
            //
            // Do NOT widen this to googleapis.com / gstatic.com in general.
            // The Google Maps JS loader (maps.googleapis.com/maps/api/js)
            // and the Identity / GSI loaders have a self-check that throws
            // NotLoadingAPIFromGoogleMapsError (and equivalents) when the
            // script is served from anywhere other than a fresh fetch off
            // their own host — replaying a cached copy via the SW trips
            // that check and produces cascading `Cannot read properties
            // of undefined` errors from main.js. Travel app died on soft
            // refresh from exactly this; hard refresh worked because it
            // bypasses the SW. Same shape as the /api/realtime SSE
            // carve-out above (commit ee90aad).
            //
            // Anything else under googleapis.com / gstatic.com should fall
            // through to the network like any other un-handled request.
            urlPattern: ({ url }) => url.hostname === "fonts.gstatic.com",
            handler: "CacheFirst",
            options: {
              cacheName: "kirkl-google",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ];
}
