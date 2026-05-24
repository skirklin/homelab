/**
 * Tests for infra/pocketbase/pb_migrations/lib/pb-json.js — the unwrapPbJson
 * helper that defends against PB's goja []byte JSON surfacing.
 *
 * We don't have a goja interpreter here; we simulate the three shapes
 * `record.get(jsonField)` can return — parsed object, JSON string, and
 * array-of-bytes — and assert the helper round-trips them to a real object.
 *
 * This isn't a substitute for hook tests against a live PB; it's the
 * cheap, fast guarantee that the recovery utility actually does what its
 * docstring claims.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/backend/src/pocketbase-hooks → repo root → infra/...
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const requireFromHere = createRequire(import.meta.url);
const { unwrapPbJson } = requireFromHere(
  path.join(repoRoot, "infra/pocketbase/pb_migrations/lib/pb-json.js"),
) as { unwrapPbJson: (raw: unknown) => Record<string, unknown> };

// Build the byte-array shape goja surfaces JSON columns as.
function asByteArray(value: unknown): number[] {
  const json = JSON.stringify(value);
  const out: number[] = [];
  for (let i = 0; i < json.length; i++) out.push(json.charCodeAt(i));
  return out;
}

describe("unwrapPbJson", () => {
  it("decodes a byte-array of JSON into an object", () => {
    const input = asByteArray({ foo: "bar", n: 1 });
    expect(unwrapPbJson(input)).toEqual({ foo: "bar", n: 1 });
  });

  it("decodes a byte-array of a JSON object with nested arrays", () => {
    const obj = { entries: [{ name: "notes", type: "text", value: "x" }], labels: { tz: "UTC" } };
    expect(unwrapPbJson(asByteArray(obj))).toEqual(obj);
  });

  it("passes through an already-parsed object", () => {
    const input = { a: 1, b: { c: "x" } };
    expect(unwrapPbJson(input)).toEqual({ a: 1, b: { c: "x" } });
  });

  it("parses a JSON string", () => {
    expect(unwrapPbJson('{"hello":"world"}')).toEqual({ hello: "world" });
  });

  it("returns {} for null", () => {
    expect(unwrapPbJson(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(unwrapPbJson(undefined)).toEqual({});
  });

  it("returns {} for a malformed byte-array (truncated JSON)", () => {
    // Bytes for `{"a":` — incomplete object.
    const partial = [0x7b, 0x22, 0x61, 0x22, 0x3a];
    expect(unwrapPbJson(partial)).toEqual({});
  });

  it("returns {} for an empty array (encodes to the string \"\")", () => {
    expect(unwrapPbJson([])).toEqual({});
  });

  it("returns {} for an unparseable JSON string", () => {
    expect(unwrapPbJson("not json {")).toEqual({});
  });

  it("documents behavior: a byte-array encoding a JSON array (not object)", () => {
    // The helper signature says `Record<string,unknown>` and the JSDoc
    // says "JS object", but the implementation will happily JSON.parse a
    // top-level array and return it. This is documented expected
    // behavior — callers that pass JSON-array columns (e.g.
    // user.recipe_boxes) should use a separate array-aware helper
    // (toJsArray in the hooks), not unwrapPbJson.
    const bytes = asByteArray(["a", "b"]);
    const result = unwrapPbJson(bytes);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["a", "b"]);
  });

  it("returns {} for a non-byte-shaped value (number)", () => {
    // Random shape — defensive default.
    expect(unwrapPbJson(42 as unknown)).toEqual({});
  });
});
