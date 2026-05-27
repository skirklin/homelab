/**
 * Shared Vite preset for kirkl.in apps.
 *
 * Authored as plain ESM (.mjs) so vite.config.ts in each app can import it
 * directly — Node loads vite configs natively and won't run TS through
 * esbuild for cross-package imports.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Resolve the dev-server proxy target for `/fn` and friends.
 *
 * Priority:
 *   1. `process.env.VITE_API_URL` (explicit override — useful for pointing
 *      a local `pnpm dev` at prod, a sibling worktree, or a remote tunnel)
 *   2. `infra/test-env.sh url --api` (when run inside this repo: discovers
 *      the per-worktree test API port derived from the worktree basename)
 *   3. `http://127.0.0.1:3001` (legacy default — main checkout's api port)
 *
 * Without #2, two worktrees doing `pnpm dev` simultaneously would both
 * proxy to `:3001`, hitting whichever api container happens to live there
 * (typically main's, or nothing). The shell-out is cheap because it
 * happens once at vite config evaluation time, not per request.
 *
 * Returns `http://127.0.0.1:<port>` (a string). All errors are swallowed
 * — falling back to the legacy default is always safe.
 */
export function resolveDevApiTarget() {
  if (process.env.VITE_API_URL) return process.env.VITE_API_URL;
  return resolveTestEnvUrl("--api") || "http://127.0.0.1:3001";
}

/**
 * Resolve the per-worktree test PocketBase URL.
 *
 * Priority:
 *   1. `process.env.PB_TEST_URL` (explicit override — set by `deploy.sh`'s
 *      pre-deploy gate so the inner `pnpm test:playwright` invocation
 *      inherits the right URL).
 *   2. `infra/test-env.sh url --pb` (when run inside this repo: discovers
 *      the per-worktree test PB port derived from the worktree basename).
 *   3. `http://127.0.0.1:8091` (legacy default — main checkout's PB port).
 *
 * Without #2, running `pnpm test:playwright` directly from a worktree
 * silently points BOTH the browser (via `VITE_PB_URL`) and the test admin
 * client at the main checkout's PB on `:8091`, while the worktree's own
 * test API container (the one the browser's `/fn` calls hit) talks to
 * the worktree's PB. The auth context for invite creation then mismatches
 * — the user JWT minted on main's PB can't be refreshed against the
 * worktree's PB, so `/fn/sharing/invite` returns 401 and the clipboard
 * shim never sees a URL. Matches the algorithm in `resolveDevApiTarget`.
 *
 * Returns a string URL; all errors fall through to the legacy default.
 */
export function resolveTestPbUrl() {
  if (process.env.PB_TEST_URL) return process.env.PB_TEST_URL;
  return resolveTestEnvUrl("--pb") || "http://127.0.0.1:8091";
}

/**
 * Shell out to `infra/test-env.sh url <flag>` to discover a per-worktree
 * port. Walks up from this preset's location to find the repo root —
 * `process.cwd()` is unreliable because callers vary (vite from app dir,
 * playwright from app dir, tests from arbitrary cwd).
 *
 * Returns the trimmed URL string on success, or `null` if the script is
 * missing/broken — the caller decides the fallback.
 */
function resolveTestEnvUrl(flag) {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "infra", "test-env.sh");
    if (existsSync(candidate)) {
      try {
        const out = execFileSync(candidate, ["url", flag], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out.startsWith("http://")) return out;
      } catch {
        // test-env.sh missing/broken — fall through.
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Find the repo root by walking up from this preset's location until we
 * see `infra/test-env.sh`. Returns `null` if not found within 8 levels —
 * the package may be consumed outside the monorepo (unlikely, but cheap
 * to be defensive).
 */
function findRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "infra", "test-env.sh"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Derive a stable per-worktree port offset from the repo-root basename.
 *
 * Mirrors `derive_port_offset` in `infra/test-env.sh`: `cksum(basename) %
 * 1000` for `.claude/worktrees/agent-X` checkouts, 0 for everything else
 * (main, plain clones). Returns an integer in [0, 999].
 *
 * Pure JS (no shell-out) so it's safe to call from vite/playwright config
 * load. The shell version stays canonical for test ports; this mirrors
 * the formula for the dev-server ports vite/playwright care about.
 */
function deriveWorktreeOffset() {
  const root = findRepoRoot();
  if (!root) return 0;
  const basename = root.split("/").filter(Boolean).pop() || "";
  if (!basename.startsWith("agent-")) return 0;
  // POSIX cksum CRC-32 (with length appended) — reproduce in JS so we
  // don't shell out. Polynomial 0x04C11DB7, init 0, no inversion, then
  // fold the byte-length tail in MSB-first.
  return cksumPosix(basename) % 1000;
}

/**
 * POSIX cksum implementation in pure JS. Matches `printf '%s' "<s>" |
 * cksum` so dev-server ports here line up with PB/API test ports derived
 * by `infra/test-env.sh`. Worktree basenames are ASCII; UTF-8 byte-length
 * works for the general case anyway.
 */
function cksumPosix(s) {
  const bytes = new TextEncoder().encode(s);
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  // Append the message length in big-endian, one byte at a time, exactly
  // like POSIX cksum: keep shifting in length bytes until length is 0.
  let len = bytes.length;
  while (len !== 0) {
    crc = ((crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
    len >>>= 8;
  }
  return (~crc) >>> 0;
}

// Pre-computed POSIX cksum CRC table (polynomial 0x04C11DB7, MSB-first).
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++) {
      c = ((c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1)) >>> 0;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Resolve the vite dev-server port for the current worktree.
 *
 * Mirrors the PB/API port-allocation scheme so that two `pnpm dev`
 * sessions in sibling worktrees don't both bind `:5173` and silently
 * share a server. Playwright's `webServer.reuseExistingServer: !CI`
 * would otherwise let the second invocation reuse the first worktree's
 * vite — tests then run against the wrong code.
 *
 * Formula: `base + (cksum(worktree-basename) % 1000)`. Main checkout
 * (and any non-worktree clone) gets exactly `base`. The offset is
 * deterministic per-worktree so logs/URLs stay stable.
 *
 * Each app passes its own base if it has historical reasons for one
 * (recipes uses 3000; others default to vite's 5173). The offset is
 * applied uniformly so two parallel worktrees always pick distinct
 * ports even if their bases collide.
 *
 * @param {number} [base=5173] Vite's port to start from.
 * @returns {number} The port this worktree should bind / target.
 */
export function resolveDevVitePort(base = 5173) {
  return base + deriveWorktreeOffset();
}

/**
 * @typedef {Object} ManifestShortcut
 * @property {string} name
 * @property {string} [short_name]
 * @property {string} [description]
 * @property {string} url
 * @property {Array<{src:string,sizes:string,type:string}>} [icons]
 */

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
 * @property {ManifestShortcut[]} [shortcuts] PWA manifest shortcuts[] — the
 *   long-press app-icon menu on Android / right-click jumplist on desktop.
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
    shortcuts = [],
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
        ...(shortcuts.length > 0 ? { shortcuts } : {}),
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
