/**
 * One-time translation of the hardcoded `TRACKABLES` (app domain) into the
 * generic, per-user `LifeManifestTrackable[]` manifest shape (backend domain).
 *
 * This is the CANONICAL definition of scott's P1 backfill. The PB migration
 * (infra/pocketbase/pb_migrations/*_life_manifest_column.js) embeds the same
 * result as literal JSON because goja can't import TS; a test in this package
 * asserts the migration's embedded JSON equals this function's output so the
 * two can never silently drift.
 *
 * Invariants the migration depends on (asserted by manifest-backfill.test.ts):
 *   - 1:1 with `TRACKABLES`, `id` preserved.
 *   - `fields[0].key === primaryEntryName(trackable.id)` — the PRIMARY field's
 *     key MUST equal the historical `life_events.entries[].name` so existing
 *     events keep aggregating after `primaryEntryName` is deleted in P2.
 *   - secondary fields use the exact historical entry/label names EventLogger
 *     wrote: intensity → entry "intensity" (rating), notes → entry "notes"
 *     (text), category → labels.category (key "category").
 *   - `presets` → `pinned[]` single-primary-entry payloads.
 *   - `hidden`, `group` preserved.
 */
import type { LifeManifest, LifeManifestTrackable, TypedField } from "@homelab/backend";
import { TRACKABLES, type Trackable } from "../trackables";
import { primaryEntryName } from "./format";

function primaryField(t: Trackable): TypedField {
  const key = primaryEntryName(t.id);
  if (t.unit === "rating") {
    // Ratings were stored as number entries with unit "rating", scale 5.
    const f: TypedField = { key, type: "rating", scale: 5 };
    return f;
  }
  const f: TypedField = { key, type: "number", unit: t.unit };
  if (t.defaultValue !== undefined) f.defaultValue = t.defaultValue;
  return f;
}

export function backfillTrackable(t: Trackable): LifeManifestTrackable {
  const fields: TypedField[] = [primaryField(t)];

  // Category picker → a `category` field whose value lands in labels.category.
  // Key is literally "category" to match the historical labels.category write.
  if (t.categories && t.categories.length > 0) {
    fields.push({ key: "category", type: "category", options: [...t.categories] });
  }
  // Intensity → a rating entry historically named "intensity".
  if (t.hasIntensity) {
    fields.push({ key: "intensity", type: "rating", scale: 5, optional: true });
  }
  // Notes → a text entry historically named "notes".
  if (t.hasNotes) {
    fields.push({ key: "notes", type: "text", optional: true });
  }

  const out: LifeManifestTrackable = {
    id: t.id,
    label: t.label,
    fields,
  };
  if (t.group !== undefined) out.group = t.group;
  if (t.hidden !== undefined) out.hidden = t.hidden;

  // Presets become pinned quick-action payloads: a single primary entry, no
  // category/intensity/notes — same shape EventLogger's preset chips wrote.
  if (t.presets && t.presets.length > 0) {
    const primaryName = primaryEntryName(t.id);
    out.pinned = t.presets.map((p) => ({
      label: p.label,
      entries: [{ name: primaryName, type: "number", value: p.value, unit: t.unit }],
    }));
  }

  return out;
}

/** Translate all hardcoded TRACKABLES into the generic manifest, 1:1. */
export function backfillManifest(): LifeManifest {
  return { trackables: TRACKABLES.map(backfillTrackable) };
}
