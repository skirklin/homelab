/**
 * Pure-function diff between two recipe.data snapshots.
 *
 * Powers the "What changed?" affordance on cooking-log entries: take the
 * snapshot of the recipe captured when the user logged a cook, compare it
 * against the current live recipe, and produce a structured, human-readable
 * diff ("milk: 3 cup → 4 cup", "+ 2 tbsp olive oil", "- 1 tsp salt").
 *
 * Naive JSON diff is too noisy for cooking — a reordered ingredient looks
 * identical to a deletion + addition, a slight whitespace change in a step
 * dwarfs a real ingredient swap. So this module operates on the recipe's
 * domain shape: ingredient strings are tokenized into (quantity, unit,
 * name, preparation) and matched by name; steps are matched by index.
 *
 * The data is small enough that a focused custom implementation beats
 * pulling in a generic diff library — and the structured ingredient match
 * is the whole feature.
 */

import type { Recipe } from "schema-dts";

// Accept either schema-dts Recipe or the @homelab/backend RecipeData
// shape (which is the same JSON-LD bag, just typed more loosely). Anything
// else is opaque — read fields defensively.
export type RecipeLike = Recipe | Record<string, unknown>;

export interface IngredientChange {
  kind: "added" | "removed" | "changed";
  /** Display label: the ingredient name (lowercased, trimmed). */
  name: string;
  /** Pre-edit raw string (undefined for added). */
  before?: string;
  /** Post-edit raw string (undefined for removed). */
  after?: string;
}

export interface StepChange {
  kind: "added" | "removed" | "changed";
  /** 1-based step index in the post-edit recipe. */
  index: number;
  before?: string;
  after?: string;
}

export interface FieldChange {
  /** Camel-case field name as stored in recipe.data. */
  field: string;
  before?: string;
  after?: string;
}

export interface RecipeDiff {
  ingredients: IngredientChange[];
  steps: StepChange[];
  fields: FieldChange[];
  /** True iff every section is empty. UI uses this to render "no changes". */
  isEmpty: boolean;
}

// --- Extractors ---

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function ingredientStrings(r: RecipeLike): string[] {
  const raw = (r as Record<string, unknown>).recipeIngredient;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const s = asString(item);
    if (s != null && s.trim() !== "") out.push(s);
  }
  return out;
}

function stepStrings(r: RecipeLike): string[] {
  const raw = (r as Record<string, unknown>).recipeInstructions;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (item == null) continue;
    if (typeof item === "string") {
      if (item.trim() !== "") out.push(item);
      continue;
    }
    if (typeof item === "object") {
      const text = (item as Record<string, unknown>).text;
      const s = asString(text);
      if (s != null && s.trim() !== "") out.push(s);
    }
  }
  return out;
}

// --- Ingredient name extraction ---

// Conservative unit list — covers the bulk of US/metric recipes. Anything not
// in here falls back to "after the leading quantity we just take the rest".
// We're not parsing for arithmetic, just for the matching key.
const UNIT_WORDS = new Set([
  "cup", "cups",
  "tsp", "tsps", "teaspoon", "teaspoons",
  "tbsp", "tbsps", "tablespoon", "tablespoons",
  "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds",
  "g", "gram", "grams",
  "kg", "kgs", "kilogram", "kilograms",
  "ml", "milliliter", "milliliters",
  "l", "liter", "liters", "litre", "litres",
  "pinch", "pinches",
  "dash", "dashes",
  "clove", "cloves",
  "can", "cans",
  "package", "packages", "pkg", "pkgs",
  "slice", "slices",
  "stick", "sticks",
  "piece", "pieces",
  "head", "heads",
  "bunch", "bunches",
  "sprig", "sprigs",
  "quart", "quarts", "qt", "qts",
  "pint", "pints", "pt", "pts",
  "gallon", "gallons", "gal",
]);

// Matches a leading quantity: mixed (1 1/2), fractions (1/2), unicode
// fractions, ranges (1-2, 1 to 2), and finally plain integers/decimals.
// Mixed forms are listed first so the regex engine prefers them — without
// that, "1 1/2 cups" matches the leading "1" and we mis-parse "1/2 cups
// whole milk" as the rest of the ingredient.
const QTY_RE = /^\s*(?:\d+\s+\d+\/\d+|\d+\/\d+|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?|\s+to\s+\d+(?:[.,]\d+)?)?)\s*/i;

/**
 * Reduce an ingredient string to its match key — the bare ingredient name,
 * lowercased and trimmed.
 *
 *   "1 1/2 cups whole milk, room temperature" -> "whole milk"
 *   "2 tbsp olive oil"                          -> "olive oil"
 *   "salt to taste"                             -> "salt to taste"
 *
 * Strips: leading quantity, leading unit word, trailing parenthetical, and
 * everything after the first comma (preparation notes like "chopped" or
 * "room temperature"). Matching is intentionally loose — we want
 * "1 cup milk" and "2 cups milk" to match, and we accept that "milk, room
 * temperature" and "milk, chilled" also collapse to "milk" (the diff line
 * will surface the full before/after strings so the user still sees the
 * preparation change).
 */
export function ingredientKey(raw: string): string {
  let s = raw.trim();
  // Drop trailing parenthetical, e.g. "olive oil (extra virgin)" -> "olive oil"
  s = s.replace(/\s*\([^)]*\)\s*$/g, "");
  // Drop everything after the first comma — that's preparation/notes.
  const comma = s.indexOf(",");
  if (comma >= 0) s = s.slice(0, comma);
  // Strip leading quantity.
  s = s.replace(QTY_RE, "");
  // Strip leading unit word (one token).
  const parts = s.split(/\s+/);
  if (parts.length > 1) {
    const head = parts[0].toLowerCase().replace(/[.]/g, "");
    if (UNIT_WORDS.has(head)) {
      parts.shift();
      s = parts.join(" ");
    }
  }
  return s.trim().toLowerCase();
}

// --- Top-level diff ---

export function diffRecipes(before: RecipeLike | undefined | null, after: RecipeLike | undefined | null): RecipeDiff {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;

  return {
    ingredients: diffIngredients(ingredientStrings(b), ingredientStrings(a)),
    steps: diffSteps(stepStrings(b), stepStrings(a)),
    fields: diffFields(b, a),
    get isEmpty() {
      return this.ingredients.length === 0 && this.steps.length === 0 && this.fields.length === 0;
    },
  };
}

// --- Ingredient diff ---

function diffIngredients(before: string[], after: string[]): IngredientChange[] {
  // Build maps keyed by ingredient name. If a key collides (recipe lists
  // "salt" twice), fold into the same bucket and join the originals so a
  // duplicate doesn't appear as one-side missing.
  const beforeByKey = new Map<string, string[]>();
  for (const s of before) {
    const k = ingredientKey(s);
    if (!k) continue;
    const arr = beforeByKey.get(k) ?? [];
    arr.push(s);
    beforeByKey.set(k, arr);
  }
  const afterByKey = new Map<string, string[]>();
  for (const s of after) {
    const k = ingredientKey(s);
    if (!k) continue;
    const arr = afterByKey.get(k) ?? [];
    arr.push(s);
    afterByKey.set(k, arr);
  }

  const allKeys = new Set<string>([...beforeByKey.keys(), ...afterByKey.keys()]);
  // Stable order: keys in their first appearance order in `after`, then any
  // removed-only keys in `before` order. Keeps the diff readable.
  const orderedKeys: string[] = [];
  const seen = new Set<string>();
  for (const s of after) {
    const k = ingredientKey(s);
    if (k && allKeys.has(k) && !seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  }
  for (const s of before) {
    const k = ingredientKey(s);
    if (k && allKeys.has(k) && !seen.has(k)) {
      orderedKeys.push(k);
      seen.add(k);
    }
  }

  const out: IngredientChange[] = [];
  for (const key of orderedKeys) {
    const bs = beforeByKey.get(key);
    const as = afterByKey.get(key);
    if (bs && !as) {
      for (const s of bs) out.push({ kind: "removed", name: key, before: s });
    } else if (!bs && as) {
      for (const s of as) out.push({ kind: "added", name: key, after: s });
    } else if (bs && as) {
      // Both present. If the raw strings are literally identical (after
      // trim), skip silently — that's the dominant case and the diff would
      // be empty noise. Otherwise surface as a change.
      // For multi-occurrence ingredients, pair them positionally; surplus on
      // either side becomes added/removed.
      const n = Math.min(bs.length, as.length);
      for (let i = 0; i < n; i++) {
        const b = bs[i].trim();
        const a = as[i].trim();
        if (b !== a) out.push({ kind: "changed", name: key, before: bs[i], after: as[i] });
      }
      for (let i = n; i < bs.length; i++) out.push({ kind: "removed", name: key, before: bs[i] });
      for (let i = n; i < as.length; i++) out.push({ kind: "added", name: key, after: as[i] });
    }
  }
  return out;
}

// --- Step diff ---

function diffSteps(before: string[], after: string[]): StepChange[] {
  const out: StepChange[] = [];
  const maxLen = Math.max(before.length, after.length);
  for (let i = 0; i < maxLen; i++) {
    const b = before[i];
    const a = after[i];
    if (b === undefined && a !== undefined) {
      out.push({ kind: "added", index: i + 1, after: a });
    } else if (b !== undefined && a === undefined) {
      out.push({ kind: "removed", index: i + 1, before: b });
    } else if (b !== undefined && a !== undefined) {
      if (b.trim() !== a.trim()) {
        out.push({ kind: "changed", index: i + 1, before: b, after: a });
      }
    }
  }
  return out;
}

// --- Scalar field diff ---

/**
 * Whitelist of scalar fields we surface in the diff. We don't show every
 * top-level key — many JSON-LD scrapes carry @context, @id, image URLs,
 * scraper metadata, etc., which would dominate the diff with noise.
 * Renderer-facing field labels live next to the table render in the modal.
 */
const SCALAR_FIELDS = [
  "name",
  "description",
  "recipeYield",
  "recipeCuisine",
  "prepTime",
  "cookTime",
  "totalTime",
  "url",
] as const;

function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of SCALAR_FIELDS) {
    const b = asString(before[field]);
    const a = asString(after[field]);
    const bn = (b ?? "").trim();
    const an = (a ?? "").trim();
    if (bn !== an) {
      out.push({ field, before: b, after: a });
    }
  }
  return out;
}
