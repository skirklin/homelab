/**
 * Tests for the inlined `toJsArray` helper in
 * infra/pocketbase/pb_hooks/sharing.pb.js and recipe-box-cleanup.pb.js.
 *
 * Background: PB stores JSON-array columns (e.g. users.recipe_boxes) as
 * Go []byte. Under goja, .get() can hand them back as one of three shapes:
 *   1. real JS Array of decoded values
 *   2. JSON string
 *   3. JS Array of UTF-8 byte values (one number per byte of the stored JSON)
 *
 * The pre-fix toJsArray (`Array.prototype.slice.call(raw)`) silently
 * returned the bytes themselves for shape (3). Callers then pushed a
 * new ID onto that and `$app.save()`-d, corrupting the column into a
 * mix of bytes + the appended value. That's the scott / recipe_boxes
 * incident on 2026-05-26.
 *
 * The fixed helper detects the byte-array shape via `typeof raw[0]`
 * (numbers 0–255 → bytes; strings → real value array) and decodes
 * shape (3) back into a real array via String.fromCharCode + JSON.parse.
 *
 * We exercise the actual shipping code by extracting the inlined
 * function from sharing.pb.js via Node `vm` and asserting it round-trips
 * each shape correctly. This mirrors the strategy in
 * sharing-redeem.test.ts for the unwrapPbJsonObject helper.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const sharingHookPath = path.join(repoRoot, "infra/pocketbase/pb_hooks/sharing.pb.js");
const cleanupHookPath = path.join(repoRoot, "infra/pocketbase/pb_hooks/recipe-box-cleanup.pb.js");
const taskTagsHookPath = path.join(repoRoot, "infra/pocketbase/pb_hooks/task_tags.pb.js");

type ToJsArray = (raw: unknown) => unknown[];

/**
 * Load a hook file in a vm sandbox with stubs that capture the registered
 * callback, then re-evaluate it inside the captured callback's closure to
 * extract the local toJsArray helper.
 *
 * The helpers are deliberately inlined per-callback (module-scope helpers
 * are unreachable inside routerAdd callbacks under goja — see the file
 * headers), so we have to invoke the callback's body to get at them. We
 * cheat: we wrap the captured handler so the very first thing it does is
 * yield its `toJsArray` reference to us via the sandbox, then we exit
 * early before the rest of the handler runs.
 */
function extractToJsArrayFromSharing(): ToJsArray {
  // Strategy: parse out the inlined function definition from the file
  // source by string-matching, then eval it in a clean sandbox. The
  // function is self-contained (no closure deps) so this is safe.
  const source = readFileSync(sharingHookPath, "utf8");
  // Match the first occurrence of `function toJsArray(raw) { ... }` up
  // through its closing brace at the correct nesting.
  return extractFunction(source, "toJsArray");
}

function extractToJsArrayFromCleanup(): ToJsArray {
  const source = readFileSync(cleanupHookPath, "utf8");
  return extractFunction(source, "toJsArray");
}

function extractToJsArrayFromTaskTags(): ToJsArray {
  const source = readFileSync(taskTagsHookPath, "utf8");
  return extractFunction(source, "toJsArray");
}

/**
 * Pluck a top-level-ish `function name(...) { ... }` definition out of a
 * source file by string scanning. Handles nested braces. Returns the
 * function as a real callable in a fresh vm context.
 */
function extractFunction(source: string, name: string): ToJsArray {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in source`);
  // Find the opening brace of the function body.
  const braceStart = source.indexOf("{", start);
  if (braceStart === -1) throw new Error(`open brace for ${name} not found`);
  // Walk forward counting brace depth.
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++; // include the closing brace
        break;
      }
    }
  }
  if (depth !== 0) throw new Error(`unbalanced braces in ${name}`);
  const body = source.slice(start, i);
  const sandbox: { fn?: ToJsArray } = {};
  vm.createContext(sandbox);
  vm.runInContext(`${body}\nfn = ${name};`, sandbox);
  if (typeof sandbox.fn !== "function") throw new Error(`failed to extract ${name}`);
  return sandbox.fn;
}

function asByteArray(value: unknown): number[] {
  const json = JSON.stringify(value);
  const out: number[] = [];
  for (let i = 0; i < json.length; i++) out.push(json.charCodeAt(i));
  return out;
}

// We run the same test matrix against both hook copies of the helper
// (they MUST stay in sync; the test makes drift visible).
const VARIANTS: Array<{ name: string; load: () => ToJsArray }> = [
  { name: "sharing.pb.js", load: extractToJsArrayFromSharing },
  { name: "recipe-box-cleanup.pb.js", load: extractToJsArrayFromCleanup },
  { name: "task_tags.pb.js", load: extractToJsArrayFromTaskTags },
];

for (const variant of VARIANTS) {
  describe(`toJsArray inlined in ${variant.name}`, () => {
    let toJsArray: ToJsArray;
    beforeAll(() => {
      toJsArray = variant.load();
    });

    it("returns [] for null", () => {
      expect(toJsArray(null)).toEqual([]);
    });

    it("returns [] for undefined", () => {
      expect(toJsArray(undefined)).toEqual([]);
    });

    it("returns [] for an empty array (could be either shape; safe default)", () => {
      expect(toJsArray([])).toEqual([]);
    });

    it("passes through a real JS array of string IDs", () => {
      const ids = ["1lp73505di9n3vr", "5631b3u60k67f17", "vdbj56dbbfp3lmd"];
      const result = toJsArray(ids);
      expect(result).toEqual(ids);
      // Should be a fresh copy (callers mutate the returned array).
      expect(result).not.toBe(ids);
    });

    it("decodes a byte-array of a JSON-encoded string array back into the values", () => {
      // This is the exact shape that corrupted scott's recipe_boxes:
      // the persisted JSON `["1lp73505di9n3vr","5631b3u60k67f17",...]`
      // is handed back as Array<number> of UTF-8 bytes. Pre-fix, push
      // would land on those bytes and persist a mixed corrupted column.
      const original = ["1lp73505di9n3vr", "5631b3u60k67f17", "abc123def456789"];
      const bytes = asByteArray(original);
      // Sanity: confirm we built the byte-array shape correctly.
      expect(typeof bytes[0]).toBe("number");
      expect(bytes[0]).toBe("[".charCodeAt(0));

      expect(toJsArray(bytes)).toEqual(original);
    });

    it("decoded byte-array is safe to push onto and JSON.stringify back", () => {
      // The actual corruption path: read → push new id → save.
      // After the fix, the round-tripped value should look like the
      // PATCH that was used to restore scott's data.
      const original = ["1lp73505di9n3vr", "5631b3u60k67f17"];
      const bytes = asByteArray(original);
      const arr = toJsArray(bytes);
      arr.push("vdbj56dbbfp3lmd");
      expect(arr).toEqual([
        "1lp73505di9n3vr",
        "5631b3u60k67f17",
        "vdbj56dbbfp3lmd",
      ]);
      // What PB would re-serialize on save: a clean JSON string array.
      expect(JSON.stringify(arr)).toBe(
        '["1lp73505di9n3vr","5631b3u60k67f17","vdbj56dbbfp3lmd"]',
      );
    });

    it("parses a JSON-string-shaped array (third goja path)", () => {
      const ids = ["1lp73505di9n3vr", "5631b3u60k67f17"];
      expect(toJsArray(JSON.stringify(ids))).toEqual(ids);
    });

    it("returns [] for a JSON string that decodes to an object (wrong shape)", () => {
      expect(toJsArray('{"a":1}')).toEqual([]);
    });

    it("returns [] for a malformed JSON string", () => {
      expect(toJsArray("not json [")).toEqual([]);
    });

    it("returns [] for a byte-array that decodes to non-JSON garbage", () => {
      // Bytes for the string "hello" — valid UTF-8 but not JSON.
      const bytes = [104, 101, 108, 108, 111];
      expect(toJsArray(bytes)).toEqual([]);
    });

    it("returns [] for a byte-array that decodes to a JSON object (wrong shape)", () => {
      const bytes = asByteArray({ a: 1 });
      expect(toJsArray(bytes)).toEqual([]);
    });

    it("returns [] for a truncated byte-array (incomplete JSON)", () => {
      // Bytes for `["abc` — truncated.
      const partial = [0x5b, 0x22, 0x61, 0x62, 0x63];
      expect(toJsArray(partial)).toEqual([]);
    });

    it("returns [] for an unexpected primitive (number)", () => {
      expect(toJsArray(42 as unknown)).toEqual([]);
    });
  });
}
