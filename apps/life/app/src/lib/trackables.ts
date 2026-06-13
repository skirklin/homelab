/**
 * Runtime vocabulary source. The app renders from the per-user manifest
 * persisted on `life_logs.manifest` (vocab rows: id + shape + prefill hints).
 *
 * `useTrackables()` is the single accessor every consumer (LifeDashboard,
 * shape sheets, Visualizations) reads through. It pulls `state.log.manifest`
 * and falls back to `DEFAULT_LIFE_MANIFEST` only if the manifest is absent
 * (a legacy log, or a transient null before the log loads) so the dashboard
 * never renders blank.
 *
 * Display groups are gone — `group` on a vocab row is a semantic rollup for
 * trends (walk/run/bike → "exercise"), not a layout section.
 */
import { useMemo } from "react";
import type { LifeManifestTrackable } from "@homelab/backend";
import { DEFAULT_LIFE_MANIFEST } from "@homelab/backend";
import { useLifeContext } from "../life-context";

/** The vocab rows for the current user's log, or the default starter set. */
export function useTrackables(): LifeManifestTrackable[] {
  const { state } = useLifeContext();
  return useMemo(() => {
    const trackables = state.log?.manifest?.trackables;
    if (trackables && trackables.length > 0) return trackables;
    return DEFAULT_LIFE_MANIFEST.trackables;
  }, [state.log?.manifest]);
}
