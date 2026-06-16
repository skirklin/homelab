/**
 * The chartable-series model shared by every Insights view.
 *
 * A `Series` is a pickable thing to analyze: one vocab row, a GROUP rollup over
 * the vocab rows sharing a `group` (walk/run/bike → "exercise"), or an unknown
 * subjectId still present in history after its vocab row was removed (degrade,
 * don't drop). Each series carries the `shape`-derived reduction policy the
 * analysis lib needs, so views never re-derive "is this a magnitude or a
 * rating" themselves.
 */
import type { LifeManifestTrackable, TrackableShape } from "@homelab/backend";
import type { LogEvent } from "../../types";

export const GROUP_PREFIX = "group:";

export interface Series {
  /** Select value. Things use their id; groups use `group:<name>`. */
  key: string;
  label: string;
  subjectIds: string[];
  /** Drives the analysis lib's per-day reduction (sum / mean-rating / count). */
  shape: TrackableShape;
  /** Magnitude unit for `took`/`did` series (min for did); "" for rated/happened. */
  defaultUnit?: string;
}

/**
 * Infer a shape for an unknown history subject from its data: a non-rating
 * number unit ⇒ "took" (a summed magnitude); only rating entries ⇒ "rated";
 * nothing numeric ⇒ "happened" (count). History predates the shape model, so
 * this keeps orphaned series chartable with a sensible reduction.
 */
function inferShape(events: LogEvent[], subjectId: string): { shape: TrackableShape; unit?: string } {
  let sawRating = false;
  for (const e of events) {
    if (e.subjectId !== subjectId) continue;
    for (const entry of e.entries) {
      if (entry.type !== "number") continue;
      if (entry.unit === "rating") sawRating = true;
      else return { shape: "took", unit: entry.unit };
    }
  }
  return sawRating ? { shape: "rated" } : { shape: "happened" };
}

/**
 * Build the pickable series list: every non-hidden vocab row, every >1-member
 * group rollup, and any unknown subjectId found in history. Hidden trackables
 * are excluded from the pickers (per the Insights spec).
 */
export function buildSeries(trackables: LifeManifestTrackable[], entries: LogEvent[]): Series[] {
  const out: Series[] = [];
  const known = new Set<string>();
  const byGroup = new Map<string, LifeManifestTrackable[]>();

  for (const t of trackables) {
    known.add(t.id);
    if (t.hidden) continue;
    out.push({ key: t.id, label: t.label, subjectIds: [t.id], shape: t.shape, defaultUnit: t.defaultUnit });
    if (t.group) {
      const list = byGroup.get(t.group);
      if (list) list.push(t);
      else byGroup.set(t.group, [t]);
    }
  }

  // Group rollups — only when the rollup actually aggregates >1 thing. A
  // group's reduction follows its members' shared shape (groups are semantic
  // rollups of like things, so the first member's shape represents the group).
  for (const [group, members] of byGroup) {
    if (members.length < 2) continue;
    out.push({
      key: `${GROUP_PREFIX}${group}`,
      label: `${group} (all)`,
      subjectIds: members.map((m) => m.id),
      shape: members[0].shape,
      defaultUnit: members[0].defaultUnit,
    });
  }

  // Unknown subjectIds in history (vocab row deleted): chart under the raw id.
  const unknown = new Set<string>();
  for (const e of entries) {
    if (!known.has(e.subjectId)) unknown.add(e.subjectId);
  }
  for (const id of [...unknown].sort()) {
    const { shape, unit } = inferShape(entries, id);
    out.push({ key: id, label: id, subjectIds: [id], shape, defaultUnit: unit });
  }

  return out;
}

/** Series rich enough to feed the analysis lib's `Pick<…>` trackable arg. */
export function trackableArg(s: Series): { shape: TrackableShape; defaultUnit?: string } {
  return { shape: s.shape, defaultUnit: s.defaultUnit };
}

/** A series carries a numeric magnitude/rating axis (vs a pure count). */
export function isNumeric(s: Series): boolean {
  return s.shape === "took" || s.shape === "did" || s.shape === "rated";
}
