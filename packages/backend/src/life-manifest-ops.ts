/**
 * Canonical validation + mutation helpers for the per-user life trackable
 * manifest (`life_logs.manifest`). These are PURE functions over a
 * `LifeManifest`: each takes the current manifest and a request, validates it,
 * and returns the next manifest — or throws `ManifestError` with a stable
 * `code`. They never touch PocketBase.
 *
 * Why a separate module: the P4 MCP tools (services/api/src/routes/data.ts) and
 * the future P5 in-app editor must enforce IDENTICAL rules — especially the
 * IMMUTABILITY of `trackable.id` and `field.key`, which are the join keys that
 * link `life_events` history. Renaming either silently orphans history
 * (apps/life/ROADMAP.md "Risks & open questions"). Centralizing the policy here
 * means there is one place that decides what a legal mutation is.
 *
 * Mutation discipline (mirrors `setTrackablePins`): every op does a structural
 * read-modify-write that touches ONLY the targeted trackable and otherwise
 * preserves the rest of the manifest byte-for-byte. Callers persist the
 * returned manifest wholesale.
 */
import type {
  LifeManifest,
  LifeManifestTrackable,
  TypedField,
  QuickPayload,
} from "./types/life";

/** Field types whose value lands in `life_events.entries[]`. */
const ENTRY_FIELD_TYPES = ["number", "rating", "text", "bool"] as const;
/** Every legal field type. `category` → `life_events.labels[key]`. */
const ALL_FIELD_TYPES = ["number", "rating", "text", "category", "bool"] as const;

/** Stable error codes so callers can map to HTTP status / messages. */
export type ManifestErrorCode =
  | "invalid_id"
  | "duplicate_id"
  | "not_found"
  | "invalid_label"
  | "invalid_field"
  | "immutable_id"
  | "immutable_field_key"
  | "field_removed"
  | "invalid_pin"
  | "invalid_order";

export class ManifestError extends Error {
  code: ManifestErrorCode;
  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

/** A trackable id / field key must be a slug: lower-kebab, starts alnum. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

function isSlug(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && SLUG_RE.test(s);
}

/**
 * Validate one `TypedField` in isolation (shape, not cross-field rules).
 * `category` requires a non-empty `options[]`; `number` may carry a `unit`;
 * `rating` may carry a numeric `scale`. The `key` must be a slug (it becomes
 * an entry name / label key in history).
 */
export function validateField(raw: unknown): TypedField {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("invalid_field", "field must be an object");
  }
  const f = raw as Record<string, unknown>;
  if (!isSlug(f.key)) {
    throw new ManifestError(
      "invalid_field",
      `field.key must be a slug (lower-kebab, [a-z0-9_-], <=64 chars); got ${JSON.stringify(f.key)}`,
    );
  }
  if (typeof f.type !== "string" || !ALL_FIELD_TYPES.includes(f.type as never)) {
    throw new ManifestError(
      "invalid_field",
      `field.type must be one of ${ALL_FIELD_TYPES.join("|")}; got ${JSON.stringify(f.type)} (key="${f.key}")`,
    );
  }
  const type = f.type as TypedField["type"];
  const out: TypedField = { key: f.key, type };

  if (type === "category") {
    if (!Array.isArray(f.options) || f.options.length === 0 || !f.options.every((o) => typeof o === "string")) {
      throw new ManifestError(
        "invalid_field",
        `category field "${f.key}" requires a non-empty options[] of strings`,
      );
    }
    out.options = f.options as string[];
  } else if (f.options !== undefined) {
    throw new ManifestError(
      "invalid_field",
      `options[] is only valid on category fields (key="${f.key}", type="${type}")`,
    );
  }

  if (type === "rating" && f.scale !== undefined) {
    if (typeof f.scale !== "number" || !Number.isFinite(f.scale) || f.scale < 2) {
      throw new ManifestError("invalid_field", `rating field "${f.key}" scale must be a number >= 2`);
    }
    out.scale = f.scale;
  }

  if (type === "number" && f.unit !== undefined) {
    if (typeof f.unit !== "string" || f.unit.length === 0) {
      throw new ManifestError("invalid_field", `number field "${f.key}" unit must be a non-empty string`);
    }
    out.unit = f.unit;
  }

  if (f.label !== undefined) {
    if (typeof f.label !== "string") throw new ManifestError("invalid_field", `field.label must be a string (key="${f.key}")`);
    out.label = f.label;
  }
  if (f.defaultValue !== undefined) {
    if (typeof f.defaultValue !== "number") {
      throw new ManifestError("invalid_field", `field.defaultValue must be a number (key="${f.key}")`);
    }
    out.defaultValue = f.defaultValue;
  }
  if (f.optional !== undefined) {
    if (typeof f.optional !== "boolean") throw new ManifestError("invalid_field", `field.optional must be a boolean (key="${f.key}")`);
    out.optional = f.optional;
  }
  return out;
}

/** Validate a fields[] array: non-empty, unique keys, each field legal. */
function validateFields(raw: unknown): TypedField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ManifestError("invalid_field", "fields[] must be a non-empty array");
  }
  const out = raw.map(validateField);
  const seen = new Set<string>();
  for (const f of out) {
    if (seen.has(f.key)) {
      throw new ManifestError("invalid_field", `duplicate field.key "${f.key}" within a trackable`);
    }
    seen.add(f.key);
  }
  return out;
}

/**
 * Validate a `pinned[]` payload list against a trackable's fields. A pin is a
 * replayable quick-action; its `entries[].name` / `labels` keys MUST be real
 * field keys of the trackable so a replayed pin writes a history-compatible
 * event. We require: measurement entries name an entry-typed field; label keys
 * name a category field.
 */
export function validatePins(raw: unknown, fields: TypedField[]): QuickPayload[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError("invalid_pin", "pinned must be an array");
  const entryKeys = new Set(fields.filter((f) => ENTRY_FIELD_TYPES.includes(f.type as never)).map((f) => f.key));
  const categoryKeys = new Set(fields.filter((f) => f.type === "category").map((f) => f.key));

  return raw.map((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      throw new ManifestError("invalid_pin", `pinned[${i}] must be an object`);
    }
    const pin = p as Record<string, unknown>;
    if (!Array.isArray(pin.entries) || pin.entries.length === 0) {
      throw new ManifestError("invalid_pin", `pinned[${i}].entries must be a non-empty array`);
    }
    for (const e of pin.entries) {
      if (!e || typeof e !== "object") throw new ManifestError("invalid_pin", `pinned[${i}] has a malformed entry`);
      const name = (e as Record<string, unknown>).name;
      if (typeof name !== "string" || !entryKeys.has(name)) {
        throw new ManifestError(
          "invalid_pin",
          `pinned[${i}] entry name "${String(name)}" must match a measurement field.key of the trackable`,
        );
      }
    }
    if (pin.labels !== undefined) {
      if (!pin.labels || typeof pin.labels !== "object" || Array.isArray(pin.labels)) {
        throw new ManifestError("invalid_pin", `pinned[${i}].labels must be an object`);
      }
      for (const k of Object.keys(pin.labels as object)) {
        if (!categoryKeys.has(k)) {
          throw new ManifestError(
            "invalid_pin",
            `pinned[${i}] label key "${k}" must match a category field.key of the trackable`,
          );
        }
      }
    }
    const out: QuickPayload = { entries: pin.entries as QuickPayload["entries"] };
    if (typeof pin.label === "string") out.label = pin.label;
    if (pin.labels) out.labels = pin.labels as Record<string, string>;
    return out;
  });
}

/** Empty manifest, used when a log has no manifest yet. */
export function emptyManifest(): LifeManifest {
  return { trackables: [] };
}

/**
 * ADD a new trackable. Validates the id slug + uniqueness, label, fields, and
 * any pins. Returns the next manifest with the trackable appended (manifest
 * order = dashboard order). Never mutates `current`.
 */
export function addTrackable(
  current: LifeManifest,
  input: {
    id: string;
    label: string;
    group?: string;
    hidden?: boolean;
    fields: unknown;
    pinned?: unknown;
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
  const fields = validateFields(input.fields);
  const next: LifeManifestTrackable = { id: input.id, label: input.label, fields };
  if (input.group !== undefined) next.group = input.group;
  if (input.hidden !== undefined) next.hidden = !!input.hidden;
  const pins = validatePins(input.pinned, fields);
  if (pins.length > 0) next.pinned = pins;
  return { trackables: [...current.trackables, next] };
}

/**
 * UPDATE an existing trackable. Patches only the provided keys
 * (label/group/hidden/fields/pinned). ENFORCES immutability:
 *   - `id` cannot change (it is the subject_id history join key).
 *   - an existing `field.key` cannot be renamed, and a field with history-
 *     bearing semantics cannot be removed/altered. Policy: the new fields[]
 *     must be a SUPERSET of the existing keys — every existing key must still
 *     be present, with an unchanged `type` (the entry-vs-label storage shape is
 *     part of the join contract). Adding brand-new fields is allowed; reordering
 *     is allowed; editing a field's label/unit/options/scale/default is allowed.
 *     Removing or retyping an existing key is rejected (`field_removed` /
 *     `immutable_field_key`) because it would orphan history.
 */
export function updateTrackable(
  current: LifeManifest,
  trackableId: string,
  patch: {
    id?: string;
    label?: string;
    group?: string | null;
    hidden?: boolean;
    fields?: unknown;
    pinned?: unknown;
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

  let effectiveFields = existing.fields;
  if (patch.fields !== undefined) {
    const proposed = validateFields(patch.fields);
    const proposedByKey = new Map(proposed.map((f) => [f.key, f]));
    // Immutability: every existing key must survive with the same type.
    for (const old of existing.fields) {
      const repl = proposedByKey.get(old.key);
      if (!repl) {
        throw new ManifestError(
          "field_removed",
          `field.key "${old.key}" cannot be removed — it is a history join key. Hide the trackable or add new fields instead.`,
        );
      }
      if (repl.type !== old.type) {
        throw new ManifestError(
          "immutable_field_key",
          `field.key "${old.key}" cannot change type ("${old.type}" → "${repl.type}") — the entry-vs-label storage shape is part of the history contract.`,
        );
      }
    }
    next.fields = proposed;
    effectiveFields = proposed;
  }

  if (patch.pinned !== undefined) {
    const pins = validatePins(patch.pinned, effectiveFields);
    if (pins.length > 0) next.pinned = pins;
    else delete next.pinned;
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
  return { trackables: reordered };
}

/**
 * Set a trackable's `pinned[]` wholesale (validated against its fields). Used
 * by the pin add/remove MCP tools, which compute the full next list. Mirrors
 * the existing `setTrackablePins` backend method but as a pure manifest op.
 */
export function setPins(current: LifeManifest, trackableId: string, pinned: unknown): LifeManifest {
  const idx = current.trackables.findIndex((t) => t.id === trackableId);
  if (idx === -1) throw new ManifestError("not_found", `no trackable with id "${trackableId}"`);
  const t = current.trackables[idx];
  const pins = validatePins(pinned, t.fields);
  const next: LifeManifestTrackable = { ...t };
  if (pins.length > 0) next.pinned = pins;
  else delete next.pinned;
  const trackables = current.trackables.slice();
  trackables[idx] = next;
  return { trackables };
}
