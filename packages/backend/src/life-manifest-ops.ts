/**
 * Canonical validation + mutation helpers for the per-user life vocabulary
 * manifest (`life_logs.manifest`). These are PURE functions over a
 * `LifeManifest`: each takes the current manifest and a request, validates it,
 * and returns the next manifest — or throws `ManifestError` with a stable
 * `code`. They never touch PocketBase.
 *
 * Why a separate module: the MCP tools (services/api/src/routes/data.ts) and
 * the in-app create path must enforce IDENTICAL rules — especially the
 * IMMUTABILITY of `trackable.id` (the subject_id history join key) and
 * `trackable.shape` (the entries[] contract for new events). Renaming an id
 * silently orphans history; changing a shape forks a series' entry shape
 * mid-history. Centralizing the policy here means there is one place that
 * decides what a legal mutation is.
 *
 * Mutation discipline (mirrors `setTrackablePins`): every op does a structural
 * read-modify-write that touches ONLY the targeted trackable and otherwise
 * preserves the rest of the manifest byte-for-byte. Callers persist the
 * returned manifest wholesale.
 */
import type {
  LifeManifest,
  LifeManifestTrackable,
  TrackableShape,
  TemplateRef,
  QuickPayload,
  LifeEntry,
} from "./types/life";

/**
 * Every legal shape, in display order. `noted` (reflective free text) is last
 * and is deliberately NOT shown on the dashboard input surfaces — see the
 * exclusion invariant in apps/life/.../lib/shapes.ts (`isReflective`).
 */
export const TRACKABLE_SHAPES = ["took", "did", "happened", "rated", "noted"] as const;

/** Stable error codes so callers can map to HTTP status / messages. */
export type ManifestErrorCode =
  | "invalid_id"
  | "duplicate_id"
  | "not_found"
  | "invalid_label"
  | "invalid_shape"
  | "immutable_id"
  | "immutable_shape"
  | "invalid_default"
  | "invalid_pin"
  | "invalid_pin_entry"
  | "invalid_order"
  // Goal layer (life-goal-ops.ts) — same ManifestError, distinct codes.
  | "invalid_goal"
  | "duplicate_goal"
  | "goal_not_found"
  | "immutable_goal";

export class ManifestError extends Error {
  code: ManifestErrorCode;
  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

/** A trackable id must be a slug: lower-kebab, starts alnum. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

function isSlug(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && SLUG_RE.test(s);
}

/**
 * Derive a vocab id slug from a free-form label ("PT" → "pt",
 * "trip planning" → "trip-planning"). Lowercases, collapses whitespace to
 * "-", strips everything outside [a-z0-9_-], trims leading/trailing
 * separators. Returns "" when nothing survives — callers must reject that.
 * Shared by the in-app "create new thing" path and the manifest migration's
 * category-explosion rule, so both produce identical ids.
 */
export function slugifyTrackableId(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}

function isShape(s: unknown): s is TrackableShape {
  return typeof s === "string" && (TRACKABLE_SHAPES as readonly string[]).includes(s);
}

function validateOptionalString(
  value: unknown,
  name: string,
  code: ManifestErrorCode,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestError(code, `${name} must be a non-empty string`);
  }
  return value;
}

function validateOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ManifestError("invalid_default", `${name} must be a finite number > 0`);
  }
  return value;
}

/**
 * Validate ONE pin entry's full shape, returning a typed `LifeEntry`. This is
 * the authoritative gate for raw-HTTP callers (the data.ts pinned routes pass
 * `pinned: unknown` straight through); the MCP layer has its own
 * `lifeEntrySchema`, but the pure op must not rely on it.
 *
 * Pins are replayable measurement payloads, so only NUMBER entries are legal:
 * text is free-form (never a stable quick-action) and the shape model writes
 * no bool entries. A `unit:"rating"` entry is forced into the canonical live
 * write shape (scale defaulting to 5, value in 1..scale) so a replayed pin
 * lands in the same aggregation bucket as a manually logged rating.
 */
function validatePinEntry(raw: unknown, ctx: string): LifeEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("invalid_pin_entry", `${ctx} must be an object`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.name !== "string" || e.name.length === 0) {
    throw new ManifestError("invalid_pin_entry", `${ctx}.name must be a non-empty string`);
  }
  if (e.type !== "number") {
    throw new ManifestError(
      "invalid_pin_entry",
      `${ctx} must be {type:"number"} — pins replay measurement values only; got ${JSON.stringify(e.type)}`,
    );
  }
  if (typeof e.value !== "number" || !Number.isFinite(e.value)) {
    throw new ManifestError("invalid_pin_entry", `${ctx} value must be a finite number; got ${JSON.stringify(e.value)}`);
  }
  if (typeof e.unit !== "string" || e.unit.length === 0) {
    throw new ManifestError("invalid_pin_entry", `${ctx} must carry a non-empty unit string; got ${JSON.stringify(e.unit)}`);
  }

  if (e.unit === "rating") {
    let scale = 5;
    if (e.scale !== undefined) {
      if (typeof e.scale !== "number" || !Number.isFinite(e.scale) || e.scale < 2) {
        throw new ManifestError("invalid_pin_entry", `${ctx} scale must be a number >= 2; got ${JSON.stringify(e.scale)}`);
      }
      scale = e.scale;
    }
    if (e.value < 1 || e.value > scale) {
      throw new ManifestError(
        "invalid_pin_entry",
        `${ctx} rating value must be a number in 1..${scale}; got ${JSON.stringify(e.value)}`,
      );
    }
    return { name: e.name, type: "number", value: e.value, unit: "rating", scale };
  }

  const out: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
  if (e.scale !== undefined) {
    if (typeof e.scale !== "number" || !Number.isFinite(e.scale)) {
      throw new ManifestError("invalid_pin_entry", `${ctx} scale must be a number; got ${JSON.stringify(e.scale)}`);
    }
    out.scale = e.scale;
  }
  return out;
}

/**
 * Validate a `pinned[]` payload list. A pin is a replayable quick-action: its
 * `entries[]` must be well-shaped number entries (see validatePinEntry) so a
 * replayed pin writes a history-compatible event. `labels{}` (if present) is
 * carried through verbatim — legacy pins may still carry category-era labels
 * and replaying them keeps the historical series coherent.
 */
export function validatePins(raw: unknown): QuickPayload[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError("invalid_pin", "pinned must be an array");

  return raw.map((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      throw new ManifestError("invalid_pin", `pinned[${i}] must be an object`);
    }
    const pin = p as Record<string, unknown>;
    if (!Array.isArray(pin.entries) || pin.entries.length === 0) {
      throw new ManifestError("invalid_pin", `pinned[${i}].entries must be a non-empty array`);
    }
    const entries: LifeEntry[] = pin.entries.map((e, j) => validatePinEntry(e, `pinned[${i}].entries[${j}]`));
    if (pin.labels !== undefined) {
      if (!pin.labels || typeof pin.labels !== "object" || Array.isArray(pin.labels)) {
        throw new ManifestError("invalid_pin", `pinned[${i}].labels must be an object`);
      }
      for (const [k, v] of Object.entries(pin.labels as object)) {
        if (typeof v !== "string") {
          throw new ManifestError("invalid_pin", `pinned[${i}].labels["${k}"] must be a string`);
        }
      }
    }
    const out: QuickPayload = { entries };
    if (typeof pin.label === "string") out.label = pin.label;
    if (pin.labels && Object.keys(pin.labels as object).length > 0) out.labels = pin.labels as Record<string, string>;
    return out;
  });
}

/**
 * Validate the optional `refs[]` view-render metadata on a vocab row. These are
 * UNUSED by capture in Phase A (the Phase-B View renderer consumes them) but
 * must round-trip through the manifest ops without being dropped or corrupted.
 * Returns the typed list, or undefined when absent. An empty array clears.
 */
function validateRefs(raw: unknown): TemplateRef[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ManifestError("invalid_default", "refs must be an array");
  const out: TemplateRef[] = raw.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new ManifestError("invalid_default", `refs[${i}] must be an object`);
    }
    const ref = r as Record<string, unknown>;
    if (typeof ref.token !== "string" || ref.token.length === 0) {
      throw new ManifestError("invalid_default", `refs[${i}].token must be a non-empty string`);
    }
    if (typeof ref.fromTrackable !== "string" || ref.fromTrackable.length === 0) {
      throw new ManifestError("invalid_default", `refs[${i}].fromTrackable must be a non-empty string`);
    }
    if (ref.within !== "day" && ref.within !== "week") {
      throw new ManifestError("invalid_default", `refs[${i}].within must be "day" or "week"`);
    }
    const next: TemplateRef = { token: ref.token, fromTrackable: ref.fromTrackable, within: ref.within };
    if (ref.entry !== undefined) {
      if (typeof ref.entry !== "string" || ref.entry.length === 0) {
        throw new ManifestError("invalid_default", `refs[${i}].entry must be a non-empty string`);
      }
      next.entry = ref.entry;
    }
    return next;
  });
  return out;
}

/** Empty manifest, used when a log has no manifest yet. */
export function emptyManifest(): LifeManifest {
  return { trackables: [] };
}

/**
 * ADD a new vocab row. Validates the id slug + uniqueness, label, shape, the
 * prefill defaults, and any pins. Returns the next manifest with the trackable
 * appended (manifest order = display order). Never mutates `current`.
 */
export function addTrackable(
  current: LifeManifest,
  input: {
    id: string;
    label: string;
    shape: string;
    group?: string;
    hidden?: boolean;
    defaultUnit?: unknown;
    defaultAmount?: unknown;
    defaultDuration?: unknown;
    ratingLabel?: unknown;
    pinned?: unknown;
    prompt?: unknown;
    hint?: unknown;
    refs?: unknown;
  },
): LifeManifest {
  if (!isSlug(input.id)) {
    throw new ManifestError("invalid_id", `trackable id must be a slug (lower-kebab, [a-z0-9_-], <=64 chars); got ${JSON.stringify(input.id)}`);
  }
  if (current.trackables.some((t) => t.id === input.id)) {
    throw new ManifestError("duplicate_id", `a trackable with id "${input.id}" already exists`);
  }
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    throw new ManifestError("invalid_label", "label must be a non-empty string");
  }
  if (!isShape(input.shape)) {
    throw new ManifestError(
      "invalid_shape",
      `shape must be one of ${TRACKABLE_SHAPES.join("|")}; got ${JSON.stringify(input.shape)}`,
    );
  }
  const next: LifeManifestTrackable = { id: input.id, label: input.label, shape: input.shape };
  const group = validateOptionalString(input.group, "group", "invalid_label");
  if (group !== undefined) next.group = group;
  if (input.hidden !== undefined) next.hidden = !!input.hidden;
  const defaultUnit = validateOptionalString(input.defaultUnit, "defaultUnit", "invalid_default");
  if (defaultUnit !== undefined) next.defaultUnit = defaultUnit;
  const defaultAmount = validateOptionalNumber(input.defaultAmount, "defaultAmount");
  if (defaultAmount !== undefined) next.defaultAmount = defaultAmount;
  const defaultDuration = validateOptionalNumber(input.defaultDuration, "defaultDuration");
  if (defaultDuration !== undefined) next.defaultDuration = defaultDuration;
  const ratingLabel = validateOptionalString(input.ratingLabel, "ratingLabel", "invalid_label");
  if (ratingLabel !== undefined) next.ratingLabel = ratingLabel;
  const pins = validatePins(input.pinned);
  if (pins.length > 0) next.pinned = pins;
  // View-render metadata (Phase-B consumers; round-trips through here).
  const prompt = validateOptionalString(input.prompt, "prompt", "invalid_label");
  if (prompt !== undefined) next.prompt = prompt;
  const hint = validateOptionalString(input.hint, "hint", "invalid_label");
  if (hint !== undefined) next.hint = hint;
  const refs = validateRefs(input.refs);
  if (refs !== undefined && refs.length > 0) next.refs = refs;
  return { trackables: [...current.trackables, next] };
}

/**
 * UPDATE an existing trackable. Patches only the provided keys. ENFORCES
 * immutability:
 *   - `id` cannot change (it is the subject_id history join key).
 *   - `shape` cannot change (it is the entries[] contract for new events;
 *     changing it would fork the series' shape mid-history).
 * Everything else (label/group/hidden/defaults/ratingLabel/pinned) is freely
 * editable; nullable fields clear with `null`.
 */
export function updateTrackable(
  current: LifeManifest,
  trackableId: string,
  patch: {
    id?: string;
    label?: string;
    shape?: string;
    group?: string | null;
    hidden?: boolean;
    defaultUnit?: unknown;
    defaultAmount?: unknown;
    defaultDuration?: unknown;
    ratingLabel?: unknown;
    pinned?: unknown;
    prompt?: unknown;
    hint?: unknown;
    refs?: unknown;
  },
): LifeManifest {
  const idx = current.trackables.findIndex((t) => t.id === trackableId);
  if (idx === -1) throw new ManifestError("not_found", `no trackable with id "${trackableId}"`);
  const existing = current.trackables[idx];

  if (patch.id !== undefined && patch.id !== trackableId) {
    throw new ManifestError(
      "immutable_id",
      `trackable id is immutable (it is the subject_id history join key); cannot rename "${trackableId}" → "${patch.id}"`,
    );
  }
  if (patch.shape !== undefined && patch.shape !== existing.shape) {
    throw new ManifestError(
      "immutable_shape",
      `trackable shape is immutable (it is the entries[] contract for new events); cannot change "${existing.shape}" → "${patch.shape}"`,
    );
  }

  const next: LifeManifestTrackable = { ...existing };

  if (patch.label !== undefined) {
    if (typeof patch.label !== "string" || patch.label.trim().length === 0) {
      throw new ManifestError("invalid_label", "label must be a non-empty string");
    }
    next.label = patch.label;
  }
  if (patch.group !== undefined) {
    if (patch.group === null || patch.group === "") delete next.group;
    else if (typeof patch.group === "string") next.group = patch.group;
    else throw new ManifestError("invalid_label", "group must be a string or null");
  }
  if (patch.hidden !== undefined) next.hidden = !!patch.hidden;

  // Nullable prefill hints: null/"" clears, otherwise validate + set.
  if (patch.defaultUnit !== undefined) {
    if (patch.defaultUnit === null || patch.defaultUnit === "") delete next.defaultUnit;
    else next.defaultUnit = validateOptionalString(patch.defaultUnit, "defaultUnit", "invalid_default");
  }
  if (patch.defaultAmount !== undefined) {
    if (patch.defaultAmount === null) delete next.defaultAmount;
    else next.defaultAmount = validateOptionalNumber(patch.defaultAmount, "defaultAmount");
  }
  if (patch.defaultDuration !== undefined) {
    if (patch.defaultDuration === null) delete next.defaultDuration;
    else next.defaultDuration = validateOptionalNumber(patch.defaultDuration, "defaultDuration");
  }
  if (patch.ratingLabel !== undefined) {
    if (patch.ratingLabel === null || patch.ratingLabel === "") delete next.ratingLabel;
    else next.ratingLabel = validateOptionalString(patch.ratingLabel, "ratingLabel", "invalid_label");
  }

  if (patch.pinned !== undefined) {
    const pins = validatePins(patch.pinned);
    if (pins.length > 0) next.pinned = pins;
    else delete next.pinned;
  }

  // View-render metadata (Phase-B). Nullable: null/"" clears.
  if (patch.prompt !== undefined) {
    if (patch.prompt === null || patch.prompt === "") delete next.prompt;
    else next.prompt = validateOptionalString(patch.prompt, "prompt", "invalid_label");
  }
  if (patch.hint !== undefined) {
    if (patch.hint === null || patch.hint === "") delete next.hint;
    else next.hint = validateOptionalString(patch.hint, "hint", "invalid_label");
  }
  if (patch.refs !== undefined) {
    const refs = validateRefs(patch.refs);
    if (refs !== undefined && refs.length > 0) next.refs = refs;
    else delete next.refs;
  }

  const trackables = current.trackables.slice();
  trackables[idx] = next;
  return { trackables };
}

/**
 * REMOVE a trackable from the manifest. Manifest-only: this NEVER touches
 * `life_events`. Events with this `subject_id` persist and re-link if a
 * trackable with the same id is re-added. Throws if absent.
 */
export function removeTrackable(current: LifeManifest, trackableId: string): LifeManifest {
  if (!current.trackables.some((t) => t.id === trackableId)) {
    throw new ManifestError("not_found", `no trackable with id "${trackableId}"`);
  }
  return { trackables: current.trackables.filter((t) => t.id !== trackableId) };
}

/**
 * REORDER trackables. `orderedIds` must be a permutation of the current
 * trackable ids (same set, no dupes, no extras). Returns the manifest with
 * trackables reordered to match.
 */
export function reorderTrackables(current: LifeManifest, orderedIds: unknown): LifeManifest {
  if (!Array.isArray(orderedIds) || !orderedIds.every((x) => typeof x === "string")) {
    throw new ManifestError("invalid_order", "order must be an array of trackable ids");
  }
  const currentIds = current.trackables.map((t) => t.id);
  const wanted = orderedIds as string[];
  if (wanted.length !== currentIds.length || new Set(wanted).size !== wanted.length) {
    throw new ManifestError(
      "invalid_order",
      `order must be a permutation of the ${currentIds.length} current trackable ids`,
    );
  }
  const byId = new Map(current.trackables.map((t) => [t.id, t]));
  const reordered: LifeManifestTrackable[] = [];
  for (const id of wanted) {
    const t = byId.get(id);
    if (!t) throw new ManifestError("invalid_order", `order references unknown trackable id "${id}"`);
    reordered.push(t);
  }
  return { ...current, trackables: reordered };
}

/**
 * Set a trackable's `pinned[]` wholesale (validated). Used by the pin
 * add/remove MCP tools, which compute the full next list. Mirrors the existing
 * `setTrackablePins` backend method but as a pure manifest op.
 */
export function setPins(current: LifeManifest, trackableId: string, pinned: unknown): LifeManifest {
  const idx = current.trackables.findIndex((t) => t.id === trackableId);
  if (idx === -1) throw new ManifestError("not_found", `no trackable with id "${trackableId}"`);
  const t = current.trackables[idx];
  const pins = validatePins(pinned);
  const next: LifeManifestTrackable = { ...t };
  if (pins.length > 0) next.pinned = pins;
  else delete next.pinned;
  const trackables = current.trackables.slice();
  trackables[idx] = next;
  return { trackables };
}
