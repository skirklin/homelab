/**
 * The runtime vocabulary source is the per-user manifest. `useTrackables()`
 * reads `state.log.manifest.trackables` (vocab rows: id + shape + prefill
 * hints) and falls back to the default starter set when the manifest is
 * absent or empty.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { DEFAULT_LIFE_MANIFEST } from "@homelab/backend";
import type { LifeManifest } from "@homelab/backend";
import { LifeProvider, useLifeContext } from "../life-context";
import { useTrackables } from "./trackables";
import type { LifeLog } from "../types";

function makeLog(manifest: LifeManifest | null): LifeLog {
  return {
    id: "log1",
    sampleSchedule: null,
    manifest,
    randomSamplingEnabled: false,
    coachEnabled: true,
    created: "2026-06-01T00:00:00Z",
    updated: "2026-06-01T00:00:00Z",
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return <LifeProvider>{children}</LifeProvider>;
}

/** Render useTrackables alongside a setter so the test can dispatch SET_LOG. */
function renderTrackables() {
  return renderHook(
    () => {
      const { dispatch } = useLifeContext();
      const trackables = useTrackables();
      return { trackables, dispatch };
    },
    { wrapper: Wrapper },
  );
}

describe("useTrackables", () => {
  it("falls back to the default starter manifest when no log/manifest is present", () => {
    const { result } = renderTrackables();
    expect(result.current.trackables.map((t) => t.id)).toEqual(
      DEFAULT_LIFE_MANIFEST.trackables.map((t) => t.id),
    );
  });

  it("reads vocab rows from state.log.manifest (not any hardcoded list)", () => {
    const custom: LifeManifest = {
      trackables: [
        { id: "meditation_xyz", label: "Meditation", shape: "did", defaultDuration: 10 },
      ],
    };
    const { result } = renderTrackables();
    act(() => {
      result.current.dispatch({ type: "SET_LOG", log: makeLog(custom) });
    });
    expect(result.current.trackables.map((t) => t.id)).toEqual(["meditation_xyz"]);
    expect(result.current.trackables[0].shape).toBe("did");
    expect(result.current.trackables.some((t) => t.id === "water")).toBe(false);
  });

  it("falls back to default when the manifest has an empty trackables array", () => {
    const { result } = renderTrackables();
    act(() => {
      result.current.dispatch({ type: "SET_LOG", log: makeLog({ trackables: [] }) });
    });
    expect(result.current.trackables.length).toBe(DEFAULT_LIFE_MANIFEST.trackables.length);
  });
});
