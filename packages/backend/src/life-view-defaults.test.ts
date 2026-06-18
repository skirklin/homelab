/**
 * Consistency tests for the default Views / View vocab / notifications. These
 * guard the internal referential integrity of the `DEFAULT_*` constants — every
 * capture item and every template ref must point at a vocab id that exists, and
 * the split-collision ids must stay distinct.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_VIEW_TRACKABLES,
  DEFAULT_VIEWS,
  DEFAULT_NOTIFICATIONS,
} from "./life-view-defaults";

const vocabIds = new Set(DEFAULT_VIEW_TRACKABLES.map((t) => t.id));

describe("DEFAULT_VIEW_TRACKABLES", () => {
  it("has unique ids", () => {
    expect(vocabIds.size).toBe(DEFAULT_VIEW_TRACKABLES.length);
  });

  it("keeps the split-collision ids distinct", () => {
    // morning.intention vs weekly.intention; evening.lesson vs weekly.lesson.
    for (const id of ["daily_intention", "weekly_intention", "daily_lesson", "weekly_lesson"]) {
      expect(vocabIds.has(id)).toBe(true);
    }
    expect("daily_intention").not.toBe("weekly_intention");
    expect("daily_lesson").not.toBe("weekly_lesson");
  });

  it("carries the original session prompt text on every row", () => {
    for (const t of DEFAULT_VIEW_TRACKABLES) {
      expect(t.prompt, `${t.id} should have a prompt`).toBeTruthy();
    }
  });

  it("is byte-faithful to the original SESSIONS prompt / hint / placeholder", () => {
    // Mirror of apps/life/app/src/manifest.ts SESSIONS — the source of truth for
    // the wizard text. `prompt` = SESSIONS label, `hint` = SESSIONS hint,
    // `placeholder` = SESSIONS placeholder. A `null` here means the SESSIONS row
    // had no value for that field (so the default row must NOT carry it). This
    // is the guard that the placeholder migration (N1) stays byte-faithful: a
    // placeholder dropped or moved into `hint` (the original B1 bug) fails here.
    // (apps/life can't be imported from packages/backend; this fixture is the
    //  copied original text, intentionally duplicated for cross-package guarding.)
    const expected: Record<string, { prompt: string; hint: string | null; placeholder: string | null }> = {
      // ── Morning ──
      gratitude: { prompt: "What are you grateful for?", hint: null, placeholder: "One thing is plenty." },
      daily_intention: {
        prompt: "What's the plan for today?",
        hint: "What are you doing, and when? Worth a glance at your calendar.",
        placeholder: "Priorities, rough timing, the shape of the day.",
      },
      // energy is a `rated` prompt: SESSIONS gives it a label + hint, no placeholder.
      energy: { prompt: "Energy", hint: "How's the tank look?", placeholder: null },
      // ── Evening ──
      intention_followup: {
        prompt: "How did the plan hold up?",
        // SESSIONS hint carries the morning-plan echo; the token is rewritten
        // from the runner's `{context}` to the data-driven ref token `{plan}`.
        hint: "This morning's plan: “{plan}”",
        placeholder: "How did it turn out? Honest beats tidy.",
      },
      daily_win: { prompt: "One thing that went well", hint: null, placeholder: "However small." },
      daily_lesson: {
        prompt: "What did today show you?",
        hint: null,
        placeholder: "Optional — something surprising, something confirmed, anything.",
      },
      // ── Weekly ──
      highlights: {
        prompt: "What's worth remembering from this week?",
        hint: null,
        placeholder: "The moments you'd want to find later.",
      },
      lows: { prompt: "What was hard?", hint: null, placeholder: "Honest, not heavy." },
      weekly_lesson: {
        prompt: "What did this week teach you?",
        hint: null,
        placeholder: "What clicked, or what got clearer.",
      },
      weekly_intention: {
        prompt: "One intention for the week ahead?",
        hint: null,
        placeholder: "Where do you want your attention?",
      },
    };
    // Every default row must be covered, and every covered row must match.
    expect(new Set(DEFAULT_VIEW_TRACKABLES.map((t) => t.id))).toEqual(new Set(Object.keys(expected)));
    for (const t of DEFAULT_VIEW_TRACKABLES) {
      const want = expected[t.id];
      expect(t.prompt, `${t.id}.prompt`).toBe(want.prompt);
      expect(t.hint ?? null, `${t.id}.hint`).toBe(want.hint);
      expect(t.placeholder ?? null, `${t.id}.placeholder`).toBe(want.placeholder);
    }
  });

  it("the energy row is the only non-noted shape", () => {
    const nonNoted = DEFAULT_VIEW_TRACKABLES.filter((t) => t.shape !== "noted");
    expect(nonNoted.map((t) => t.id)).toEqual(["energy"]);
    expect(nonNoted[0].shape).toBe("rated");
    expect(nonNoted[0].ratingLabel).toBe("Energy");
  });
});

describe("DEFAULT_VIEWS", () => {
  it("has the three session Views in order, all guided", () => {
    expect(DEFAULT_VIEWS.map((v) => v.id)).toEqual(["morning", "evening", "weekly"]);
    for (const v of DEFAULT_VIEWS) expect(v.render).toBe("guided");
  });

  it("every capture item references a known vocab id", () => {
    for (const view of DEFAULT_VIEWS) {
      for (const item of view.items) {
        if (item.kind === "capture") {
          expect(vocabIds.has(item.trackableId), `${view.id}: ${item.trackableId}`).toBe(true);
        }
      }
    }
  });

  it("every template ref (banner + vocab) resolves to a known vocab id", () => {
    // Banner refs live on the view items.
    for (const view of DEFAULT_VIEWS) {
      for (const item of view.items) {
        if (item.kind === "banner") {
          for (const ref of item.refs) {
            expect(vocabIds.has(ref.fromTrackable), `banner ref ${ref.fromTrackable}`).toBe(true);
          }
        }
      }
    }
    // Vocab refs live on the trackable rows.
    for (const t of DEFAULT_VIEW_TRACKABLES) {
      for (const ref of t.refs ?? []) {
        expect(vocabIds.has(ref.fromTrackable), `${t.id} ref ${ref.fromTrackable}`).toBe(true);
      }
    }
  });

  it("renders non-capture blocks before the first capture (renderer contract)", () => {
    for (const view of DEFAULT_VIEWS) {
      const firstCapture = view.items.findIndex((i) => i.kind === "capture");
      if (firstCapture < 0) continue;
      const after = view.items.slice(firstCapture);
      expect(after.every((i) => i.kind === "capture")).toBe(true);
    }
  });

  it("morning leads with tasks_due then a banner, then the morning captures", () => {
    const morning = DEFAULT_VIEWS.find((v) => v.id === "morning")!;
    expect(morning.items[0].kind).toBe("tasks_due");
    expect(morning.items[1].kind).toBe("banner");
    const captures = morning.items.filter((i) => i.kind === "capture");
    expect(captures.map((i) => (i as { trackableId: string }).trackableId)).toEqual([
      "gratitude",
      "daily_intention",
      "energy",
    ]);
  });

  it("evening's intention_followup is optional and refs daily_intention within day", () => {
    const evening = DEFAULT_VIEWS.find((v) => v.id === "evening")!;
    const followup = evening.items.find(
      (i) => i.kind === "capture" && i.trackableId === "intention_followup",
    ) as { optional?: boolean } | undefined;
    expect(followup?.optional).toBe(true);
    const vocab = DEFAULT_VIEW_TRACKABLES.find((t) => t.id === "intention_followup")!;
    expect(vocab.refs?.[0]).toMatchObject({
      token: "plan",
      fromTrackable: "daily_intention",
      within: "day",
    });
  });

  it("the morning banner refs weekly_intention within week", () => {
    const morning = DEFAULT_VIEWS.find((v) => v.id === "morning")!;
    const banner = morning.items.find((i) => i.kind === "banner") as {
      refs: { token: string; fromTrackable: string; within: string }[];
    };
    expect(banner.refs[0]).toMatchObject({
      token: "wk",
      fromTrackable: "weekly_intention",
      within: "week",
    });
  });
});

describe("DEFAULT_NOTIFICATIONS", () => {
  it("has exactly the three fixed session reminders, each targeting its View", () => {
    expect(DEFAULT_NOTIFICATIONS.map((n) => n.id)).toEqual(["morning", "evening", "weekly"]);
    for (const n of DEFAULT_NOTIFICATIONS) {
      expect(n.strategy.kind).toBe("fixed");
      expect(vocabViewIds.has(n.target), `target ${n.target}`).toBe(true);
    }
  });

  it("does NOT model the random sampling notification (Phase B4)", () => {
    expect(DEFAULT_NOTIFICATIONS.some((n) => n.strategy.kind === "random")).toBe(false);
  });

  it("weekly fires Sunday and subsumes evening", () => {
    const weekly = DEFAULT_NOTIFICATIONS.find((n) => n.id === "weekly")!;
    if (weekly.strategy.kind !== "fixed") throw new Error("weekly must be fixed");
    expect(weekly.strategy.cadence).toBe("weekly");
    expect(weekly.strategy.weekday).toBe(0);
    expect(weekly.strategy.subsumes).toEqual(["evening"]);
  });
});

const vocabViewIds = new Set(DEFAULT_VIEWS.map((v) => v.id));
