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
            // workbox's StaleWhileRevalidate buffers the entire response
            // before serving — fine for normal JSON, fatal for SSE.
            // PocketBase opens its realtime channel at /api/realtime with
            // an `Accept: text/event-stream` header; if workbox intercepts
            // that, the stream never establishes and the client thinks
            // realtime is permanently down (Angela's 2026-05-19 bug —
            // hard refresh bypasses the SW and works; plain refresh
            // installs the SW and SSE breaks until the SW is unregistered).
            urlPattern: ({ url, request }) => {
              if (request.method !== "GET") return false;
              if (!(url.pathname.startsWith("/fn/") || url.pathname.startsWith("/api/"))) return false;
              // Belt + suspenders — match by path AND Accept header.
              if (url.pathname === "/api/realtime") return false;
              if ((request.headers.get("accept") || "").includes("text/event-stream")) return false;
              return true;
            },
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "kirkl-api",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) =>
              url.hostname.endsWith("googleapis.com") || url.hostname.endsWith("gstatic.com"),
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
