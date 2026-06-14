import { describe, it, expect } from "vitest";
import type { LifeEvent, LifeEntry, LifeManifestTrackable, LifeGoal } from "./types/life";
import { evaluateGoal } from "./life-goal-eval";

let counter = 0;
function ev(subjectId: string, entries: LifeEntry[], when: Date): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: when,
    entries,
    createdBy: "u1",
    created: when.toISOString(),
    updated: when.toISOString(),
  };
}
const num = (name: string, value: number, unit: string): LifeEntry[] => [
  { name, type: "number", value, unit },
];

// All boundary math is now in an explicit IANA tz. These tests pin the
// evaluator under a fixed zone (Pacific) so they don't depend on the runner's
// clock. `at(...)` builds the UTC instant of a Pacific wall-clock time, so the
// event lands on the day/hour the test author means regardless of TZ env.
const TZ = "America/Los_Angeles";
const PT_OFFSET = "-07:00"; // PDT for all June/late-May dates used below
/** UTC instant for a Pacific (PDT) wall-clock time. */
function at(year: number, month1: number, day: number, hour = 12): Date {
  const mm = String(month1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  return new Date(`${year}-${mm}-${dd}T${hh}:00:00${PT_OFFSET}`);
}

const TRACKABLES: LifeManifestTrackable[] = [
  { id: "water", label: "Water", shape: "took", defaultUnit: "oz" },
  { id: "run", label: "Run", shape: "did", group: "exercise" },
  { id: "walk", label: "Walk", shape: "did", group: "exercise" },
  { id: "yoga", label: "Yoga", shape: "did", group: "exercise", hidden: true },
  { id: "floss", label: "Floss", shape: "happened" },
];

describe("evaluateGoal — metric: count (at_least, day)", () => {
  const goal: LifeGoal = { id: "floss-daily", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 2, period: "day" };
  it("counts qualifying events in the day; unmet when short", () => {
    const ref = at(2026, 6, 10);
    const events = [ev("floss", num("count", 1, "ct"), at(2026, 6, 10, 8))];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.value).toBe(1);
    expect(p.met).toBe(false);
    expect(p.remaining).toBe(1);
  });
  it("met when count reaches target; excludes other days", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("floss", num("count", 1, "ct"), at(2026, 6, 10, 8)),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 10, 21)),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 9, 8)), // prior day
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.value).toBe(2);
    expect(p.met).toBe(true);
    expect(p.remaining).toBe(0);
  });
});

describe("evaluateGoal — metric: sum (at_least, day) name-agnostic by unit", () => {
  const goal: LifeGoal = { id: "hydrate", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 64, period: "day" };
  it("sums oz entries regardless of entry name", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("water", num("amount", 16, "oz"), at(2026, 6, 10, 8)),
      ev("water", num("volume", 50, "oz"), at(2026, 6, 10, 14)), // legacy name
      ev("water", num("amount", 8, "ml"), at(2026, 6, 10, 18)), // wrong unit, ignored
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.value).toBe(66);
    expect(p.met).toBe(true);
  });
});

describe("evaluateGoal — metric: days (frequency, week) + group scope", () => {
  const goal: LifeGoal = { id: "move", label: "Move", scope: { group: "exercise" }, kind: "frequency", metric: "days", target: 3, period: "week" };
  it("counts distinct days across group members in the Sun-start week", () => {
    // Week containing Wed 2026-06-10 is Sun 06-07 .. Sat 06-13.
    const ref = at(2026, 6, 10);
    const events = [
      ev("run", num("duration", 30, "min"), at(2026, 6, 8, 7)), // Mon
      ev("walk", num("duration", 20, "min"), at(2026, 6, 8, 18)), // same Mon — still 1 day
      ev("run", num("duration", 30, "min"), at(2026, 6, 10, 7)), // Wed
      ev("walk", num("duration", 20, "min"), at(2026, 6, 12, 7)), // Fri
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.value).toBe(3); // Mon, Wed, Fri
    expect(p.met).toBe(true);
  });
  it("excludes hidden group members (yoga)", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("yoga", num("duration", 30, "min"), at(2026, 6, 8, 7)),
      ev("yoga", num("duration", 30, "min"), at(2026, 6, 9, 7)),
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.value).toBe(0);
  });
  it("excludes events from the adjacent week (boundary)", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("run", num("duration", 30, "min"), at(2026, 6, 6, 7)), // Sat prior week
      ev("run", num("duration", 30, "min"), at(2026, 6, 14, 7)), // Sun next week
      ev("run", num("duration", 30, "min"), at(2026, 6, 10, 7)), // this week
    ];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.value).toBe(1);
  });
});

describe("evaluateGoal — kind: at_most (cap)", () => {
  const goal: LifeGoal = { id: "limit-drinks", label: "Limit drinks", scope: { thing: "water" }, kind: "at_most", metric: "sum", unit: "drinks", target: 2, period: "day" };
  it("met when at/under cap; remaining is headroom", () => {
    const ref = at(2026, 6, 10);
    const under = evaluateGoal(goal, [ev("water", num("drinks", 1, "drinks"), at(2026, 6, 10, 20))], TRACKABLES, TZ, ref);
    expect(under.met).toBe(true);
    expect(under.remaining).toBe(1); // one more allowed
  });
  it("not met (over cap); remaining clamps to 0", () => {
    const ref = at(2026, 6, 10);
    const over = evaluateGoal(goal, [
      ev("water", num("drinks", 2, "drinks"), at(2026, 6, 10, 19)),
      ev("water", num("drinks", 2, "drinks"), at(2026, 6, 10, 22)),
    ], TRACKABLES, TZ, ref);
    expect(over.value).toBe(4);
    expect(over.met).toBe(false);
    expect(over.remaining).toBe(0);
  });
});

describe("evaluateGoal — streak", () => {
  const goal: LifeGoal = { id: "floss-daily", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" };
  function flossOn(day: number): LifeEvent {
    return ev("floss", num("count", 1, "ct"), at(2026, 6, day, 9));
  }
  it("counts consecutive met days ending at ref", () => {
    const ref = at(2026, 6, 10);
    const events = [flossOn(10), flossOn(9), flossOn(8)];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.streak).toBe(3);
  });
  it("breaks the streak on a missed day", () => {
    const ref = at(2026, 6, 10);
    // 10 met, 9 met, 8 MISSED, 7 met → streak should be 2 (10, 9), not 4.
    const events = [flossOn(10), flossOn(9), flossOn(7)];
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.streak).toBe(2);
  });
  it("streak is 0 when the current period is not met", () => {
    const ref = at(2026, 6, 10);
    const events = [flossOn(9), flossOn(8)]; // nothing today
    const p = evaluateGoal(goal, events, TRACKABLES, TZ, ref);
    expect(p.met).toBe(false);
    expect(p.streak).toBe(0);
  });
  it("weekly streak counts consecutive met weeks", () => {
    const wGoal: LifeGoal = { id: "w", label: "Weekly floss", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 1, period: "week" };
    const ref = at(2026, 6, 10); // week Sun 06-07..Sat 06-13
    // prior week = May 31..Jun 6 (06-03); week before = May 24..May 30 (05-28).
    const events = [
      flossOn(10),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 3, 9)),
      ev("floss", num("count", 1, "ct"), at(2026, 5, 28, 9)),
    ];
    const p = evaluateGoal(wGoal, events, TRACKABLES, TZ, ref);
    expect(p.streak).toBe(3);
  });
  it("weekly streak breaks on a skipped week", () => {
    const wGoal: LifeGoal = { id: "w2", label: "Weekly floss", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 1, period: "week" };
    const ref = at(2026, 6, 10);
    // this week + week-before (skipping the immediately-prior week) → streak 1.
    const events = [flossOn(10), ev("floss", num("count", 1, "ct"), at(2026, 5, 28, 9))];
    const p = evaluateGoal(wGoal, events, TRACKABLES, TZ, ref);
    expect(p.streak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 1: timezone — boundaries must be in the passed IANA tz, not runtime.
// ---------------------------------------------------------------------------
describe("evaluateGoal — explicit timezone boundaries", () => {
  const goal: LifeGoal = { id: "floss-daily", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" };
  // 18:00 Pacific on 2026-06-10 === 01:00 UTC on 2026-06-11. Evaluated in
  // Pacific it belongs to the LOCAL day/week of the 10th; evaluated in UTC it
  // would land on the 11th — the exact server/dashboard disagreement we fixed.
  const evening = new Date("2026-06-10T18:00:00-07:00"); // = 2026-06-11T01:00:00Z
  const events = [ev("floss", num("count", 1, "ct"), evening)];

  it("counts a 6pm-Pacific event in the correct LOCAL day under Pacific tz", () => {
    const ref = new Date("2026-06-10T12:00:00-07:00");
    const p = evaluateGoal(goal, events, TRACKABLES, "America/Los_Angeles", ref);
    expect(p.value).toBe(1);
    expect(p.met).toBe(true);
  });

  it("would land on the WRONG day if evaluated in UTC (asserts the difference)", () => {
    // Same event, evaluated in UTC against the UTC day of the 10th: the event
    // is at 01:00Z on the 11th, so the UTC-10th window does NOT contain it.
    const refUtc = new Date("2026-06-10T12:00:00Z");
    const utc = evaluateGoal(goal, events, TRACKABLES, "UTC", refUtc);
    expect(utc.value).toBe(0);
    // And the Pacific evaluation of the same instant DOES count it → they differ.
    const refPt = new Date("2026-06-10T12:00:00-07:00");
    const pt = evaluateGoal(goal, events, TRACKABLES, "America/Los_Angeles", refPt);
    expect(pt.value).toBe(1);
    expect(pt.value).not.toBe(utc.value);
  });

  it("week boundary: a Sat-evening Pacific event stays in its local week", () => {
    const wGoal: LifeGoal = { id: "wk", label: "Weekly floss", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 1, period: "week" };
    // Sat 2026-06-13 23:00 PT = Sun 2026-06-14 06:00 UTC. The Pacific week is
    // Sun 06-07..Sat 06-13, so the event is the LAST day of that week; in UTC
    // it would spill into the next week (Sun 06-14).
    const lateSat = new Date("2026-06-13T23:00:00-07:00");
    const refWk = new Date("2026-06-10T12:00:00-07:00"); // Wed of that week
    const p = evaluateGoal(wGoal, [ev("floss", num("count", 1, "ct"), lateSat)], TRACKABLES, "America/Los_Angeles", refWk);
    expect(p.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 2: at_most empty-history streak must be 0 (not 366). Streak is
// "consecutive periods kept under the cap since you started tracking it."
// ---------------------------------------------------------------------------
describe("evaluateGoal — at_most streak bounding", () => {
  const cap: LifeGoal = { id: "cap", label: "Drink cap", scope: { thing: "water" }, kind: "at_most", metric: "sum", unit: "drinks", target: 2, period: "day" };
  const drinks = (n: number, day: number) => ev("water", num("drinks", n, "drinks"), at(2026, 6, day, 20));

  it("no history ⇒ streak 0 (vacuously-empty caps don't inflate it)", () => {
    const ref = at(2026, 6, 10);
    const p = evaluateGoal(cap, [], TRACKABLES, TZ, ref);
    expect(p.met).toBe(true); // 0 ≤ 2 — today is technically under the cap
    expect(p.streak).toBe(0); // but no tracking history ⇒ no streak
  });

  it("a clean run since the first event counts only tracked periods", () => {
    const ref = at(2026, 6, 10);
    // First tracked day is the 8th. Days 8,9,10 each under the cap ⇒ streak 3,
    // and it must NOT credit the empty days before the 8th.
    const events = [drinks(1, 8), drinks(2, 9), drinks(1, 10)];
    const p = evaluateGoal(cap, events, TRACKABLES, TZ, ref);
    expect(p.streak).toBe(3);
  });

  it("an overage breaks the streak", () => {
    const ref = at(2026, 6, 10);
    // 10 ok, 9 OVER (3 > 2), 8 ok → streak counts only the 10th.
    const events = [drinks(1, 10), drinks(3, 9), drinks(1, 8)];
    const p = evaluateGoal(cap, events, TRACKABLES, TZ, ref);
    expect(p.streak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Finding 3: group goals must include the hidden husk whose id === group, so
// legacy `subjectId:<group>` events still count toward the group.
// ---------------------------------------------------------------------------
describe("evaluateGoal — group includes the hidden husk", () => {
  // Migration leaves a hidden `{id:"exercise", group:"exercise"}` husk so old
  // `subjectId:"exercise"` events still belong to the group; `run` is a normal
  // visible member; `yoga` is a hidden NON-husk member (must stay excluded).
  const tr: LifeManifestTrackable[] = [
    { id: "exercise", label: "Exercise", shape: "did", group: "exercise", hidden: true },
    { id: "run", label: "Run", shape: "did", group: "exercise" },
    { id: "yoga", label: "Yoga", shape: "did", group: "exercise", hidden: true },
  ];
  const goal: LifeGoal = { id: "move", label: "Move", scope: { group: "exercise" }, kind: "frequency", metric: "days", target: 1, period: "week" };

  it("counts a legacy husk event AND a member event without double-counting", () => {
    const ref = at(2026, 6, 10); // week Sun 06-07..Sat 06-13
    const events = [
      ev("exercise", num("duration", 30, "min"), at(2026, 6, 8, 7)), // legacy husk, Mon
      ev("run", num("duration", 30, "min"), at(2026, 6, 10, 7)),     // member, Wed
      ev("yoga", num("duration", 30, "min"), at(2026, 6, 11, 7)),    // hidden non-husk, excluded
    ];
    const p = evaluateGoal(goal, events, tr, TZ, ref);
    expect(p.value).toBe(2); // Mon (husk) + Wed (run); yoga excluded
  });

  it("husk + member on the SAME day count as one (days metric, no double-count)", () => {
    const ref = at(2026, 6, 10);
    const events = [
      ev("exercise", num("duration", 30, "min"), at(2026, 6, 8, 7)),
      ev("run", num("duration", 30, "min"), at(2026, 6, 8, 18)), // same Mon
    ];
    const p = evaluateGoal(goal, events, tr, TZ, ref);
    expect(p.value).toBe(1);
  });
});
