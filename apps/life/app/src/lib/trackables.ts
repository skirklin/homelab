/**
 * Runtime trackable source (P2). The app renders from the per-user manifest
 * persisted on `life_logs.manifest` rather than the hardcoded `TRACKABLES`
 * array — that array survives only as the default-template / backfill seed
 * (see ../trackables.ts) and the PWA-shortcut source until P3.
 *
 * `useTrackables()` is the single accessor every consumer (LifeDashboard,
 * EventLogger, Visualizations) reads through. It pulls `state.log.manifest`
 * and falls back to `DEFAULT_LIFE_MANIFEST` only if the manifest is absent
 * (a legacy log that predates the P1 backfill, or a transient null before the
 * log loads) so the dashboard never renders blank.
 */
import { useMemo } from "react";
import type { LifeManifestTrackable, TypedField } from "@homelab/backend";
import { DEFAULT_LIFE_MANIFEST } from "@homelab/backend";
import { useLifeContext } from "../life-context";

/**
 * Static default group ordering applied over the manifest's trackables. The
 * manifest does not (yet) carry an explicit group order, so this preserves the
 * old dashboard ordering. Groups not in this list fall through after these,
 * in manifest order; trackables without a group land in the "more" bucket.
 */
export const GROUP_ORDER = ["medical", "consumables", "bio", "time-based", "body", "mind"] as const;

/** The trackables for the current user's log, or the default starter set. */
export function useTrackables(): LifeManifestTrackable[] {
  const { state } = useLifeContext();
  return useMemo(() => {
    const trackables = state.log?.manifest?.trackables;
    if (trackables && trackables.length > 0) return trackables;
    return DEFAULT_LIFE_MANIFEST.trackables;
  }, [state.log?.manifest]);
}

/**
 * The "primary" measurement field of a trackable — the one whose numeric value
 * the dashboard aggregates and the charts plot. It's the first non-`category`
 * field (categories live in labels, never carry the headline number). Falls
 * back to `fields[0]` for a degenerate category-only trackable.
 */
export function primaryField(t: LifeManifestTrackable): TypedField | undefined {
  return t.fields.find((f) => f.type !== "category") ?? t.fields[0];
}

/**
 * The aggregation unit for a field: rating fields aggregate as "rating" (avg),
 * number fields by their `unit`. Used to drive `aggregationFor` / display.
 */
export function fieldUnit(field: TypedField | undefined): string {
  if (!field) return "ct";
  if (field.type === "rating") return "rating";
  return field.unit ?? "ct";
}
