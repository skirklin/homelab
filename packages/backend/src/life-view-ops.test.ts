import { describe, it, expect } from "vitest";
import {
  addView,
  updateView,
  removeView,
  reorderViews,
  manifestViews,
  addNotification,
  updateNotification,
  removeNotification,
  reorderNotifications,
  manifestNotifications,
} from "./life-view-ops";
import { ManifestError } from "./life-manifest-ops";
import type { LifeManifest, LifeView, LifeNotification } from "./types/life";

/**
 * A manifest carrying trackables + goals + ONE view + ONE notification, so
 * every test can assert that the SIBLING keys survive a mutation byte-for-byte
 * (the load-bearing sibling-preservation invariant).
 */
function base(): LifeManifest {
  return {
    trackables: [
      { id: "water", label: "Water", shape: "took", defaultUnit: "oz" },
      { id: "gratitude", label: "Gratitude", shape: "noted" },
      { id: "energy", label: "Energy", shape: "rated", ratingLabel: "energy" },
    ],
    goals: [
      { id: "hydrate", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" },
    ],
    views: [
      {
        id: "morning",
        title: "Morning",
        greeting: "Good morning",
        icon: "sun",
        render: "guided",
        items: [
          { kind: "tasks_due" },
          { kind: "capture", trackableId: "gratitude" },
          { kind: "capture", trackableId: "energy", optional: true },
        ],
      },
    ],
    notifications: [
      {
        id: "morning-reminder",
        target: "morning",
        strategy: { kind: "fixed", cadence: "daily", time: "08:00" },
        enabled: true,
      },
    ],
  };
}

const VALID_VIEW = {
  id: "evening",
  title: "Evening",
  greeting: "Wind down",
  render: "guided" as const,
  items: [
    { kind: "capture" as const, trackableId: "gratitude" },
    { kind: "banner" as const, text: "This week: {wk}", refs: [{ token: "wk", fromTrackable: "weekly_intention", within: "week" as const }] },
  ],
};

const VALID_NOTIF = {
  id: "evening-reminder",
  target: "evening",
  strategy: { kind: "fixed" as const, cadence: "daily" as const, time: "21:00" },
};

// ──────────────────────────────── Views ────────────────────────────────

describe("addView", () => {
  it("appends + returns a new manifest, leaving the input untouched", () => {
    const cur = base();
    const next = addView(cur, VALID_VIEW);
    expect(manifestViews(next).map((v) => v.id)).toEqual(["morning", "evening"]);
    expect(manifestViews(cur)).toHaveLength(1); // immutable input
  });

  it("preserves all sibling manifest keys byte-for-byte", () => {
    const cur = base();
    const next = addView(cur, VALID_VIEW);
    expect(next.trackables).toEqual(cur.trackables);
    expect(next.goals).toEqual(cur.goals);
    expect(next.notifications).toEqual(cur.notifications);
  });

  it("seeds views[] on a manifest that has none", () => {
    const next = addView({ trackables: [] }, VALID_VIEW);
    expect(manifestViews(next)).toHaveLength(1);
  });

  it("rejects duplicate id", () => {
    let err: ManifestError | undefined;
    try { addView(base(), { ...VALID_VIEW, id: "morning" }); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("duplicate_view");
  });

  it("rejects non-slug id", () => {
    expect(() => addView(base(), { ...VALID_VIEW, id: "Bad Id" })).toThrow(/slug/);
  });

  it("requires a non-empty title", () => {
    expect(() => addView(base(), { ...VALID_VIEW, id: "x", title: "" })).toThrow(/title/);
  });

  it("requires items to be an array", () => {
    expect(() => addView(base(), { ...VALID_VIEW, id: "x", items: "nope" })).toThrow(/items must be an array/);
  });

  it("rejects a capture item with no trackableId", () => {
    expect(() => addView(base(), { ...VALID_VIEW, id: "x", items: [{ kind: "capture" }] })).toThrow(/trackableId/);
  });

  it("rejects a banner with empty text or bad refs", () => {
    expect(() => addView(base(), { ...VALID_VIEW, id: "x", items: [{ kind: "banner", text: "", refs: [] }] })).toThrow(/text/);
    expect(() => addView(base(), { ...VALID_VIEW, id: "y", items: [{ kind: "banner", text: "hi", refs: [{ token: "t" }] }] })).toThrow(/fromTrackable/);
  });

  it("rejects an unknown item kind", () => {
    expect(() => addView(base(), { ...VALID_VIEW, id: "x", items: [{ kind: "frobnicate" }] })).toThrow(/kind must be one of/);
  });

  it("rejects a bad render value", () => {
    expect(() => addView(base(), { ...VALID_VIEW, id: "x", render: "fancy" })).toThrow(/render must be one of/);
  });

  it("defaults banner refs to [] and normalizes tasks_due", () => {
    const next = addView(base(), {
      id: "x",
      title: "X",
      items: [{ kind: "tasks_due", extra: "ignored" }, { kind: "capture", trackableId: "water", optional: false }],
    });
    const v = manifestViews(next).find((x) => x.id === "x") as LifeView;
    expect(v.items[0]).toEqual({ kind: "tasks_due" });
    expect(v.items[1]).toEqual({ kind: "capture", trackableId: "water", optional: false });
  });
});

describe("updateView", () => {
  it("patches title/greeting/render and preserves siblings + items", () => {
    const cur = base();
    const next = updateView(cur, "morning", { title: "AM", greeting: "Hi" });
    const v = manifestViews(next).find((x) => x.id === "morning") as LifeView;
    expect(v.title).toBe("AM");
    expect(v.greeting).toBe("Hi");
    expect(v.items).toHaveLength(3); // unchanged
    expect(next.trackables).toEqual(cur.trackables);
    expect(next.goals).toEqual(cur.goals);
    expect(next.notifications).toEqual(cur.notifications);
  });

  it("clears greeting/icon with empty string and unsets render with null", () => {
    const next = updateView(base(), "morning", { greeting: "", icon: "", render: null });
    const v = manifestViews(next).find((x) => x.id === "morning") as LifeView;
    expect(v.greeting).toBeUndefined();
    expect(v.icon).toBeUndefined();
    expect(v.render).toBeUndefined();
  });

  it("replaces items wholesale when provided", () => {
    const next = updateView(base(), "morning", { items: [{ kind: "capture", trackableId: "water" }] });
    const v = manifestViews(next).find((x) => x.id === "morning") as LifeView;
    expect(v.items).toEqual([{ kind: "capture", trackableId: "water" }]);
  });

  it("rejects id mutation as immutable", () => {
    let err: ManifestError | undefined;
    try { updateView(base(), "morning", { id: "other" }); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("immutable_view_id");
  });

  it("re-validates patched items", () => {
    expect(() => updateView(base(), "morning", { items: [{ kind: "capture" }] })).toThrow(/trackableId/);
  });

  it("throws when view not found", () => {
    let err: ManifestError | undefined;
    try { updateView(base(), "nope", { title: "x" }); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("view_not_found");
  });
});

describe("removeView", () => {
  it("removes the view, manifest-only, preserving siblings", () => {
    const cur = base();
    const next = removeView(cur, "morning");
    expect(manifestViews(next)).toHaveLength(0);
    expect(next.trackables).toEqual(cur.trackables);
    expect(next.goals).toEqual(cur.goals);
    expect(next.notifications).toEqual(cur.notifications);
  });
  it("throws when absent", () => {
    let err: ManifestError | undefined;
    try { removeView(base(), "nope"); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("view_not_found");
  });
});

describe("reorderViews", () => {
  function multi(): LifeManifest {
    const m = base();
    return {
      ...m,
      views: [
        ...manifestViews(m), // morning
        { id: "evening", title: "Evening", items: [] },
        { id: "weekly", title: "Weekly", items: [] },
      ],
    };
  }

  it("reorders to match a permutation, preserving siblings", () => {
    const m = multi();
    const next = reorderViews(m, ["weekly", "morning", "evening"]);
    expect(manifestViews(next).map((v) => v.id)).toEqual(["weekly", "morning", "evening"]);
    expect(next.trackables).toEqual(m.trackables);
    expect(next.notifications).toEqual(m.notifications);
  });

  it("does not mutate the input", () => {
    const m = multi();
    reorderViews(m, ["weekly", "evening", "morning"]);
    expect(manifestViews(m).map((v) => v.id)).toEqual(["morning", "evening", "weekly"]);
  });

  it("rejects a non-permutation, dupes, and unknown ids", () => {
    expect(() => reorderViews(multi(), ["morning", "evening"])).toThrow(/permutation/);
    expect(() => reorderViews(multi(), ["morning", "morning", "evening"])).toThrow(/permutation/);
    expect(() => reorderViews(multi(), ["morning", "evening", "ghost"])).toThrow(/unknown view id/);
    expect(() => reorderViews(multi(), "morning")).toThrow(/array of view ids/);
  });
});

// ───────────────────────────── Notifications ─────────────────────────────

describe("addNotification", () => {
  it("appends + returns a new manifest, leaving the input untouched", () => {
    const cur = base();
    const next = addNotification(cur, VALID_NOTIF);
    expect(manifestNotifications(next).map((n) => n.id)).toEqual(["morning-reminder", "evening-reminder"]);
    expect(manifestNotifications(cur)).toHaveLength(1);
  });

  it("preserves all sibling manifest keys byte-for-byte", () => {
    const cur = base();
    const next = addNotification(cur, VALID_NOTIF);
    expect(next.trackables).toEqual(cur.trackables);
    expect(next.goals).toEqual(cur.goals);
    expect(next.views).toEqual(cur.views);
  });

  it("seeds notifications[] on a manifest that has none", () => {
    const next = addNotification({ trackables: [] }, VALID_NOTIF);
    expect(manifestNotifications(next)).toHaveLength(1);
  });

  it("rejects duplicate id", () => {
    let err: ManifestError | undefined;
    try { addNotification(base(), { ...VALID_NOTIF, id: "morning-reminder" }); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("duplicate_notification");
  });

  it("rejects non-slug id and empty target", () => {
    expect(() => addNotification(base(), { ...VALID_NOTIF, id: "Bad Id" })).toThrow(/slug/);
    expect(() => addNotification(base(), { ...VALID_NOTIF, id: "x", target: "" })).toThrow(/target/);
  });

  it("validates a fixed strategy: cadence, time format", () => {
    expect(() => addNotification(base(), { id: "x", target: "morning", strategy: { kind: "fixed", cadence: "monthly", time: "08:00" } })).toThrow(/cadence/);
    expect(() => addNotification(base(), { id: "y", target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "8am" } })).toThrow(/time/);
    expect(() => addNotification(base(), { id: "z", target: "morning", strategy: { kind: "fixed", cadence: "daily", time: "25:00" } })).toThrow(/time/);
  });

  it("allows empty-string time (never-deliver sentinel)", () => {
    const next = addNotification(base(), { id: "weekly-subsume", target: "weekly", strategy: { kind: "fixed", cadence: "weekly", time: "", weekday: 0, subsumes: ["evening-reminder"] } });
    const n = manifestNotifications(next).find((x) => x.id === "weekly-subsume") as LifeNotification;
    expect(n.strategy).toEqual({ kind: "fixed", cadence: "weekly", time: "", weekday: 0, subsumes: ["evening-reminder"] });
  });

  it("validates fixed weekday range and subsumes shape", () => {
    expect(() => addNotification(base(), { id: "x", target: "morning", strategy: { kind: "fixed", cadence: "weekly", time: "08:00", weekday: 7 } })).toThrow(/weekday/);
    expect(() => addNotification(base(), { id: "y", target: "morning", strategy: { kind: "fixed", cadence: "weekly", time: "08:00", subsumes: [""] } })).toThrow(/subsumes/);
  });

  it("validates a random strategy: timesPerDay + activeHours", () => {
    const next = addNotification(base(), { id: "samp", target: "morning", strategy: { kind: "random", timesPerDay: 3, activeHours: [9, 21] } });
    const n = manifestNotifications(next).find((x) => x.id === "samp") as LifeNotification;
    expect(n.strategy).toEqual({ kind: "random", timesPerDay: 3, activeHours: [9, 21] });
    expect(() => addNotification(base(), { id: "x", target: "morning", strategy: { kind: "random", timesPerDay: 0, activeHours: [9, 21] } })).toThrow(/timesPerDay/);
    expect(() => addNotification(base(), { id: "y", target: "morning", strategy: { kind: "random", timesPerDay: 2, activeHours: [9] } })).toThrow(/activeHours/);
    expect(() => addNotification(base(), { id: "z", target: "morning", strategy: { kind: "random", timesPerDay: 2, activeHours: [9, 25] } })).toThrow(/activeHours/);
    // start must be strictly before end — the consumer cron silently rejects
    // start >= end, so an inverted/degenerate window must not persist.
    expect(() => addNotification(base(), { id: "w", target: "morning", strategy: { kind: "random", timesPerDay: 2, activeHours: [21, 9] } })).toThrow(/activeHours start must be < end/);
    expect(() => addNotification(base(), { id: "v", target: "morning", strategy: { kind: "random", timesPerDay: 2, activeHours: [9, 9] } })).toThrow(/activeHours start must be < end/);
  });

  it("rejects an unknown strategy kind", () => {
    expect(() => addNotification(base(), { id: "x", target: "morning", strategy: { kind: "psychic" } })).toThrow(/strategy.kind must be one of/);
  });

  it("carries optional custom title/body through, leaving siblings intact", () => {
    const cur = base();
    const next = addNotification(cur, { ...VALID_NOTIF, title: "Check your habits", body: "Tap to tick them off." });
    const n = manifestNotifications(next).find((x) => x.id === "evening-reminder") as LifeNotification;
    expect(n.title).toBe("Check your habits");
    expect(n.body).toBe("Tap to tick them off.");
    expect(next.trackables).toEqual(cur.trackables);
    expect(next.notifications?.[0]).toEqual(cur.notifications?.[0]); // sibling untouched
  });

  it("omits title/body when absent or empty", () => {
    const next = addNotification(base(), { ...VALID_NOTIF, title: "", body: undefined });
    const n = manifestNotifications(next).find((x) => x.id === "evening-reminder") as LifeNotification;
    expect(n.title).toBeUndefined();
    expect(n.body).toBeUndefined();
  });

  it("rejects a non-string title/body", () => {
    expect(() => addNotification(base(), { ...VALID_NOTIF, id: "a", title: 5 })).toThrow(/title must be a string/);
    expect(() => addNotification(base(), { ...VALID_NOTIF, id: "b", body: {} })).toThrow(/body must be a string/);
  });
});

describe("updateNotification", () => {
  it("patches target/enabled, preserving siblings", () => {
    const cur = base();
    const next = updateNotification(cur, "morning-reminder", { target: "evening", enabled: false });
    const n = manifestNotifications(next).find((x) => x.id === "morning-reminder") as LifeNotification;
    expect(n.target).toBe("evening");
    expect(n.enabled).toBe(false);
    expect(next.trackables).toEqual(cur.trackables);
    expect(next.goals).toEqual(cur.goals);
    expect(next.views).toEqual(cur.views);
  });

  it("replaces strategy wholesale when kind is unchanged", () => {
    const next = updateNotification(base(), "morning-reminder", { strategy: { kind: "fixed", cadence: "weekly", time: "07:30", weekday: 1 } });
    const n = manifestNotifications(next).find((x) => x.id === "morning-reminder") as LifeNotification;
    expect(n.strategy).toEqual({ kind: "fixed", cadence: "weekly", time: "07:30", weekday: 1 });
  });

  it("rejects id mutation as immutable", () => {
    let err: ManifestError | undefined;
    try { updateNotification(base(), "morning-reminder", { id: "other" }); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("immutable_notification_id");
  });

  it("rejects changing strategy.kind as immutable", () => {
    let err: ManifestError | undefined;
    try {
      updateNotification(base(), "morning-reminder", { strategy: { kind: "random", timesPerDay: 3, activeHours: [9, 21] } });
    } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("immutable_notification_strategy_kind");
    expect(err?.message).toMatch(/strategy.kind is immutable/);
  });

  it("re-validates a patched strategy", () => {
    expect(() => updateNotification(base(), "morning-reminder", { strategy: { kind: "fixed", cadence: "daily", time: "nope" } })).toThrow(/time/);
  });

  it("rejects empty target", () => {
    expect(() => updateNotification(base(), "morning-reminder", { target: "" })).toThrow(/target/);
  });

  it("throws when notification not found", () => {
    let err: ManifestError | undefined;
    try { updateNotification(base(), "nope", { enabled: true }); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("notification_not_found");
  });

  it("sets, then clears custom title/body, preserving siblings", () => {
    const cur = base();
    // Set both.
    const withCopy = updateNotification(cur, "morning-reminder", { title: "Habits", body: "Check in" });
    const set = manifestNotifications(withCopy).find((x) => x.id === "morning-reminder") as LifeNotification;
    expect(set.title).toBe("Habits");
    expect(set.body).toBe("Check in");
    // Other manifest keys + the rest of the notification survive.
    expect(withCopy.trackables).toEqual(cur.trackables);
    expect(withCopy.views).toEqual(cur.views);
    expect(set.target).toBe("morning");
    expect(set.strategy).toEqual({ kind: "fixed", cadence: "daily", time: "08:00" });

    // Clear with "" and null respectively.
    const cleared = updateNotification(withCopy, "morning-reminder", { title: "", body: null });
    const c = manifestNotifications(cleared).find((x) => x.id === "morning-reminder") as LifeNotification;
    expect(c.title).toBeUndefined();
    expect(c.body).toBeUndefined();
    expect(c.target).toBe("morning"); // sibling fields intact
  });

  it("rejects a non-string title/body patch", () => {
    expect(() => updateNotification(base(), "morning-reminder", { title: 5 as unknown as string })).toThrow(/title must be a string/);
    expect(() => updateNotification(base(), "morning-reminder", { body: {} as unknown as string })).toThrow(/body must be a string/);
  });
});

describe("removeNotification", () => {
  it("removes the notification, preserving siblings", () => {
    const cur = base();
    const next = removeNotification(cur, "morning-reminder");
    expect(manifestNotifications(next)).toHaveLength(0);
    expect(next.trackables).toEqual(cur.trackables);
    expect(next.goals).toEqual(cur.goals);
    expect(next.views).toEqual(cur.views);
  });
  it("throws when absent", () => {
    let err: ManifestError | undefined;
    try { removeNotification(base(), "nope"); } catch (e) { err = e as ManifestError; }
    expect(err?.code).toBe("notification_not_found");
  });
});

describe("reorderNotifications", () => {
  function multi(): LifeManifest {
    const m = base();
    return {
      ...m,
      notifications: [
        ...manifestNotifications(m), // morning-reminder
        { id: "evening-reminder", target: "evening", strategy: { kind: "fixed", cadence: "daily", time: "21:00" } },
        { id: "sample", target: "morning", strategy: { kind: "random", timesPerDay: 3, activeHours: [9, 21] } },
      ],
    };
  }

  it("reorders to match a permutation, preserving siblings", () => {
    const m = multi();
    const next = reorderNotifications(m, ["sample", "morning-reminder", "evening-reminder"]);
    expect(manifestNotifications(next).map((n) => n.id)).toEqual(["sample", "morning-reminder", "evening-reminder"]);
    expect(next.trackables).toEqual(m.trackables);
    expect(next.views).toEqual(m.views);
  });

  it("does not mutate the input", () => {
    const m = multi();
    reorderNotifications(m, ["sample", "evening-reminder", "morning-reminder"]);
    expect(manifestNotifications(m).map((n) => n.id)).toEqual(["morning-reminder", "evening-reminder", "sample"]);
  });

  it("rejects a non-permutation, dupes, and unknown ids", () => {
    expect(() => reorderNotifications(multi(), ["morning-reminder", "evening-reminder"])).toThrow(/permutation/);
    expect(() => reorderNotifications(multi(), ["sample", "sample", "morning-reminder"])).toThrow(/permutation/);
    expect(() => reorderNotifications(multi(), ["morning-reminder", "evening-reminder", "ghost"])).toThrow(/unknown notification id/);
    expect(() => reorderNotifications(multi(), "morning-reminder")).toThrow(/array of notification ids/);
  });
});
