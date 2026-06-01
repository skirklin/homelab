/**
 * P2 — the runtime trackable source is the per-user manifest, not the
 * hardcoded TRACKABLES. `useTrackables()` reads `state.log.manifest.trackables`
 * and falls back to the default starter set when the manifest is absent.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { DEFAULT_LIFE_MANIFEST } from "@homelab/backend";
import type { LifeManifest } from "@homelab/backend";
import { LifeProvider, useLifeContext } from "../life-context";
import { useTrackables, primaryField, fieldUnit } from "./trackables";
import type { LifeLog } from "../types";

function makeLog(manifest: LifeManifest | null): LifeLog {
  return {
    id: "log1",
    sampleSchedule: null,
    manifest,
    randomSamplingEnabled: false,
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

  it("reads a custom trackable id from state.log.manifest (not the hardcoded list)", () => {
    const custom: LifeManifest = {
      trackables: [
        {
          id: "meditation_xyz",
          label: "Meditation",
          fields: [{ key: "duration", type: "number", unit: "min", defaultValue: 10 }],
        },
      ],
    };
    const { result } = renderTrackables();
    // Inject the log with the custom manifest.
    act(() => {
      result.current.dispatch({ type: "SET_LOG", log: makeLog(custom) });
    });
    expect(result.current.trackables.map((t) => t.id)).toEqual(["meditation_xyz"]);
    // The hardcoded "vyvanse" is NOT present — proves we read the manifest.
    expect(result.current.trackables.some((t) => t.id === "vyvanse")).toBe(false);
  });

  it("falls back to default when the manifest has an empty trackables array", () => {
    const { result } = renderTrackables();
    act(() => {
      result.current.dispatch({ type: "SET_LOG", log: makeLog({ trackables: [] }) });
    });
    expect(result.current.trackables.length).toBe(DEFAULT_LIFE_MANIFEST.trackables.length);
  });
});

describe("primaryField / fieldUnit", () => {
  it("primaryField skips category fields", () => {
    const f = primaryField({
      id: "movement",
      label: "Movement",
      fields: [
        { key: "kind", type: "category", options: ["a"] },
        { key: "duration", type: "number", unit: "min" },
      ],
    });
    expect(f?.key).toBe("duration");
  });

  it("fieldUnit returns 'rating' for rating fields, the unit for number fields", () => {
    expect(fieldUnit({ key: "r", type: "rating", scale: 5 })).toBe("rating");
    expect(fieldUnit({ key: "v", type: "number", unit: "oz" })).toBe("oz");
    expect(fieldUnit({ key: "c", type: "number" })).toBe("ct");
  });
});
