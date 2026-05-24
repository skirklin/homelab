/**
 * Read a JSON column's value as a plain JS object from a goja migration.
 *
 * PocketBase stores JSON columns as Go []byte internally. When goja accesses
 * them via record.get(), the value surfaces as a JS array of byte values
 * (one number per UTF-8 byte of the stored JSON), NOT a parsed object.
 *
 * This helper detects the byte-array form and decodes it back to a real
 * object. Also handles already-parsed objects (defensive), JSON strings, and
 * null/undefined.
 *
 * The migration at 20260522_221157_life_event_unified_shape.js corrupted
 * sessions and lost composite-trackable data because it used
 * `JSON.parse(JSON.stringify(r.get("data") || {}))` which round-trips the
 * byte-array form into a JS array of numbers, then per-subject mapRow
 * branches treated that as an object. See the recovery script in
 * services/scripts/historical/recover-life-events.ts.
 *
 * Layout note: lives under pb_migrations/lib/ so the PB migration loader
 * (which globs `NNNN_*.js` at the top level) does not try to run it as a
 * migration. Migrations require() it relatively:
 *
 *   const { unwrapPbJson } = require("./lib/pb-json.js");
 *
 * CommonJS (`module.exports`) so goja can require() it; mirrors the
 * convention established by lib/authz-rules.js.
 */

function unwrapPbJson(raw) {
  if (raw == null) return {};
  // Already-parsed object (rare in goja, but defensive).
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  // String form (some PB versions / SDK paths return JSON as string).
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  // Array form: array of UTF-8 byte values.
  if (Array.isArray(raw)) {
    var s = "";
    for (var i = 0; i < raw.length; i++) {
      s += String.fromCharCode(raw[i]);
    }
    try { return JSON.parse(s); } catch (_) { return {}; }
  }
  return {};
}

module.exports = { unwrapPbJson: unwrapPbJson };
