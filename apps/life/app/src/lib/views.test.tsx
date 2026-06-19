/**
 * `useViews` / `useNotifications` resolve the per-user manifest, falling back to
 * the `DEFAULT_*` constants. The load-bearing distinction: `undefined` →
 * default, but an explicit `[]` → empty (Angela trims to none).
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { DEFAULT_VIEWS, DEFAULT_NOTIFICATIONS } from "@homelab/backend";
import type { LifeManifest, LifeView, LifeNotification } from "@homelab/backend";
import { LifeProvider, useLifeContext } from "../life-context";
import { useViews, useNotifications } from "./views";
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

function renderViews() {
  return renderHook(
    () => {
      const { dispatch } = useLifeContext();
      const views = useViews();
      const notifications = useNotifications();
      return { views, notifications, dispatch };
    },
    { wrapper: Wrapper },
  );
}

const TRACKABLES: LifeManifest["trackables"] = [
  { id: "x", label: "X", shape: "noted" },
];

describe("useViews", () => {
  it("falls back to DEFAULT_VIEWS when no log/manifest is present", () => {
    const { result } = renderViews();
    expect(result.current.views).toBe(DEFAULT_VIEWS);
  });

  it("falls back to DEFAULT_VIEWS when manifest.views is undefined", () => {
    const { result } = renderViews();
    act(() => {
      result.current.dispatch({ type: "SET_LOG", log: makeLog({ trackables: TRACKABLES }) });
    });
    expect(result.current.views.map((v) => v.id)).toEqual(DEFAULT_VIEWS.map((v) => v.id));
  });

  it("resolves an explicit empty array to NO views (Angela)", () => {
    const { result } = renderViews();
    act(() => {
      result.current.dispatch({
        type: "SET_LOG",
        log: makeLog({ trackables: TRACKABLES, views: [] }),
      });
    });
    expect(result.current.views).toEqual([]);
  });

  it("resolves custom views verbatim", () => {
    const custom: LifeView[] = [
      { id: "focus", title: "Focus", render: "guided", items: [{ kind: "tasks_due" }] },
    ];
    const { result } = renderViews();
    act(() => {
      result.current.dispatch({
        type: "SET_LOG",
        log: makeLog({ trackables: TRACKABLES, views: custom }),
      });
    });
    expect(result.current.views).toEqual(custom);
  });
});

describe("useNotifications", () => {
  it("falls back to DEFAULT_NOTIFICATIONS when absent", () => {
    const { result } = renderViews();
    expect(result.current.notifications).toBe(DEFAULT_NOTIFICATIONS);
  });

  it("resolves an explicit empty array to NO notifications", () => {
    const { result } = renderViews();
    act(() => {
      result.current.dispatch({
        type: "SET_LOG",
        log: makeLog({ trackables: TRACKABLES, notifications: [] }),
      });
    });
    expect(result.current.notifications).toEqual([]);
  });

  it("resolves custom notifications verbatim", () => {
    const custom: LifeNotification[] = [
      {
        id: "n1",
        target: "focus",
        strategy: { kind: "random", timesPerDay: 3, activeHours: [9, 21] },
      },
    ];
    const { result } = renderViews();
    act(() => {
      result.current.dispatch({
        type: "SET_LOG",
        log: makeLog({ trackables: TRACKABLES, notifications: custom }),
      });
    });
    expect(result.current.notifications).toEqual(custom);
  });
});
