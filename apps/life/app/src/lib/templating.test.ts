import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeEntry, TemplateRef } from "@homelab/backend";
import { resolveTemplate } from "./templating";

const TZ = "America/Los_Angeles";
// A fixed "now": 2026-06-18 12:00 local (PDT, UTC-7) → 19:00Z.
const NOW = new Date("2026-06-18T19:00:00Z");

function ev(
  subjectId: string,
  timestamp: string,
  entries: LifeEntry[],
): LifeEvent {
  return {
    id: `${subjectId}-${timestamp}`,
    log: "log1",
    subjectId,
    timestamp: new Date(timestamp),
    entries,
    createdBy: "u1",
    created: timestamp,
    updated: timestamp,
  };
}

function note(text: string): LifeEntry[] {
  return [{ name: "note", type: "text", value: text }];
}

describe("resolveTemplate", () => {
  it("returns the text unchanged when there are no refs", () => {
    expect(resolveTemplate("plain text", undefined, [], TZ, NOW)).toBe("plain text");
    expect(resolveTemplate("plain text", [], [], TZ, NOW)).toBe("plain text");
  });

  it("resolves a single token from today's most-recent event (day window)", () => {
    const events = [
      ev("daily_intention", "2026-06-18T15:00:00Z", note("ship the thing")),
    ];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("This morning's plan: {plan}", refs, events, TZ, NOW)).toBe(
      "This morning's plan: ship the thing",
    );
  });

  it("picks the most-recent event when several are in window", () => {
    const events = [
      ev("daily_intention", "2026-06-18T15:00:00Z", note("early plan")),
      ev("daily_intention", "2026-06-18T17:30:00Z", note("revised plan")),
    ];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("{plan}", refs, events, TZ, NOW)).toBe("revised plan");
  });

  it("resolves multiple distinct tokens", () => {
    const events = [
      ev("daily_intention", "2026-06-18T15:00:00Z", note("focus work")),
      ev("weekly_intention", "2026-06-15T15:00:00Z", note("rest more")),
    ];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
      { token: "wk", fromTrackable: "weekly_intention", within: "week" },
    ];
    expect(
      resolveTemplate("Today: {plan}. This week: {wk}.", refs, events, TZ, NOW),
    ).toBe("Today: focus work. This week: rest more.");
  });

  it("substitutes every occurrence of a repeated token", () => {
    const events = [ev("daily_intention", "2026-06-18T15:00:00Z", note("X"))];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("{plan} and {plan}", refs, events, TZ, NOW)).toBe("X and X");
  });

  it("drops (returns null) when a required ref has no event in window", () => {
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("{plan}", refs, [], TZ, NOW)).toBeNull();
  });

  it("drops when the resolved entry is empty / whitespace", () => {
    const events = [ev("daily_intention", "2026-06-18T15:00:00Z", note("   "))];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("{plan}", refs, events, TZ, NOW)).toBeNull();
  });

  it("day window ignores yesterday's event", () => {
    // 2026-06-17 23:00Z = 16:00 local on the 17th → previous local day.
    const events = [ev("daily_intention", "2026-06-17T23:00:00Z", note("stale"))];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("{plan}", refs, events, TZ, NOW)).toBeNull();
  });

  it("week window resolves an event from 6 days ago but not 8 days ago", () => {
    const within: TemplateRef = { token: "wk", fromTrackable: "weekly_intention", within: "week" };
    const sixDaysAgo = [ev("weekly_intention", "2026-06-12T19:00:00Z", note("in window"))];
    const eightDaysAgo = [ev("weekly_intention", "2026-06-10T19:00:00Z", note("too old"))];
    expect(resolveTemplate("{wk}", [within], sixDaysAgo, TZ, NOW)).toBe("in window");
    expect(resolveTemplate("{wk}", [within], eightDaysAgo, TZ, NOW)).toBeNull();
  });

  it("ignores events for other trackables", () => {
    const events = [ev("gratitude", "2026-06-18T15:00:00Z", note("wrong subject"))];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("{plan}", refs, events, TZ, NOW)).toBeNull();
  });

  it("honors ref.entry override and pulls that named entry", () => {
    const events = [
      ev("daily_intention", "2026-06-18T15:00:00Z", [
        { name: "note", type: "text", value: "the note" },
        { name: "headline", type: "text", value: "the headline" },
      ]),
    ];
    const refs: TemplateRef[] = [
      { token: "h", fromTrackable: "daily_intention", within: "day", entry: "headline" },
    ];
    expect(resolveTemplate("{h}", refs, events, TZ, NOW)).toBe("the headline");
  });

  it("leaves an unknown {token} intact when no ref backs it (no drop)", () => {
    const events = [ev("daily_intention", "2026-06-18T15:00:00Z", note("X"))];
    const refs: TemplateRef[] = [
      { token: "plan", fromTrackable: "daily_intention", within: "day" },
    ];
    expect(resolveTemplate("{plan} {other}", refs, events, TZ, NOW)).toBe("X {other}");
  });
});
