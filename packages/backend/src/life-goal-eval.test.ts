import { describe, it, expect } from "vitest";
import { zonedDateTime, dayKey, startOfDay, endOfDay, startOfWeek } from "./life-goal-eval";
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
describe("zonedDateTime — wall-clock H:M in an explicit tz", () => {
  it("builds an instant that reads as the given wall-clock in tz", () => {
    // Noon Pacific on 2026-06-15 is 19:00 UTC.
    const seed = new Date(Date.UTC(2026, 5, 15, 12));
    const noonPt = zonedDateTime(seed, 12, 0, "America/Los_Angeles");
    expect(noonPt.toISOString()).toBe("2026-06-15T19:00:00.000Z");
    expect(dayKey(noonPt, "America/Los_Angeles")).toBe("2026-06-15");
  });

  it("a backfill at 23:00 lands inside that day's tz bucket", () => {
    const seed = new Date(Date.UTC(2026, 5, 15, 12));
    const lateNight = zonedDateTime(seed, 23, 0, "America/Los_Angeles");
    // 23:00 PT June 15 = 06:00 UTC June 16, but it must bucket on June 15 PT,
    // inside [startOfDay, endOfDay] of that local day.
    expect(dayKey(lateNight, "America/Los_Angeles")).toBe("2026-06-15");
    expect(lateNight >= startOfDay(seed, "America/Los_Angeles")).toBe(true);
    expect(lateNight <= endOfDay(seed, "America/Los_Angeles")).toBe(true);
  });
});

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

// ---------------------------------------------------------------------------
// Perf refactor (bucket-once) lock: extra edge cases the bucketing must keep
// identical, plus a brute-force reference oracle ("old == new") that re-derives
// value + streak via per-period re-filtering — the strongest guard that the
// O(events+periods) rewrite changed nothing observable.
// ---------------------------------------------------------------------------
describe("evaluateGoal — bucketing edge cases", () => {
  it("daily streak with a gap breaks at the gap (count metric)", () => {
    const goal: LifeGoal = { id: "g", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" };
    const ref = at(2026, 6, 12);
    // 12 met, 11 met, 10 MISSED, 9 met, 8 met → streak = 2 (12, 11).
    const events = [
      ev("floss", num("count", 1, "ct"), at(2026, 6, 12, 9)),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 11, 9)),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 9, 9)),
      ev("floss", num("count", 1, "ct"), at(2026, 6, 8, 9)),
    ];
    expect(evaluateGoal(goal, events, TRACKABLES, TZ, ref).streak).toBe(2);
  });

  it("at_most cap: met when ≤ target, broken streak on the over-period (sum)", () => {
    const cap: LifeGoal = { id: "c", label: "Cap", scope: { thing: "water" }, kind: "at_most", metric: "sum", unit: "drinks", target: 2, period: "day" };
    const ref = at(2026, 6, 12);
    // 12: 2 (met), 11: 3 (OVER), 10: 0-but-tracked(met) — streak stops at 12.
    const events = [
      ev("water", num("drinks", 2, "drinks"), at(2026, 6, 12, 20)),
      ev("water", num("drinks", 3, "drinks"), at(2026, 6, 11, 20)),
      ev("water", num("drinks", 1, "drinks"), at(2026, 6, 10, 20)),
    ];
    const p = evaluateGoal(cap, events, TRACKABLES, TZ, ref);
    expect(p.value).toBe(2);
    expect(p.met).toBe(true);
    expect(p.streak).toBe(1);
  });

  it("sum selects the unit-matching entry, ignoring other-unit numbers in the same event", () => {
    const goal: LifeGoal = { id: "h", label: "Hydrate", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 10, period: "day" };
    const ref = at(2026, 6, 12);
    const events = [
      ev("water", [
        { name: "amount", type: "number", value: 8, unit: "oz" },
        { name: "caffeine", type: "number", value: 95, unit: "mg" }, // wrong unit
      ], at(2026, 6, 12, 9)),
      ev("water", num("volume", 4, "oz"), at(2026, 6, 12, 14)),
    ];
    expect(evaluateGoal(goal, events, TRACKABLES, TZ, ref).value).toBe(12);
  });

  it("week-period bucketing: an event exactly at the week boundary lands in its own week", () => {
    const wGoal: LifeGoal = { id: "w", label: "Weekly", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 1, period: "week" };
    const ref = at(2026, 6, 10); // week Sun 06-07 .. Sat 06-13
    // Exactly start-of-week (Sun 06-07 00:00 PT) must count in THIS week, and
    // one ms before it must NOT.
    const weekStart = startOfWeek(ref, TZ); // Sun 06-07 00:00 PT as UTC
    const atStart = ev("floss", num("count", 1, "ct"), weekStart);
    const beforeStart = ev("floss", num("count", 1, "ct"), new Date(weekStart.getTime() - 1));
    expect(evaluateGoal(wGoal, [atStart], TRACKABLES, TZ, ref).value).toBe(1);
    expect(evaluateGoal(wGoal, [beforeStart], TRACKABLES, TZ, ref).value).toBe(0);
  });

  it("event exactly at start-of-day boundary counts in that day", () => {
    const goal: LifeGoal = { id: "g", label: "Floss", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" };
    const ref = at(2026, 6, 12);
    const dayStart = startOfDay(ref, TZ); // 06-12 00:00 PT as UTC
    expect(evaluateGoal(goal, [ev("floss", num("count", 1, "ct"), dayStart)], TRACKABLES, TZ, ref).value).toBe(1);
    // one ms earlier is the previous day → not in today
    expect(evaluateGoal(goal, [ev("floss", num("count", 1, "ct"), new Date(dayStart.getTime() - 1))], TRACKABLES, TZ, ref).value).toBe(0);
  });
});

// Brute-force reference implementation: re-derives the result the OLD way
// (full re-filter per period) so we can assert old == new across many shapes.
const MAX_STREAK_LOOKBACK = 366;
function refPeriodBounds(period: LifeGoal["period"], r: Date, tz: string) {
  if (period === "week") {
    // Week is [startOfWeek(r), startOfWeek(r+7d) − 1ms). Deriving the end from
    // the NEXT week's tz-aware start keeps DST correct (no naive +7d UTC math).
    const start = startOfWeek(r, tz);
    const nextWeekSeed = new Date(start.getTime() + 9 * 86400000); // safely into next week
    const end = new Date(startOfWeek(nextWeekSeed, tz).getTime() - 1);
    return { start, end };
  }
  // Day: [startOfDay(r), startOfDay(r+~36h) − 1ms) keeps DST correct vs endOfDay.
  const start = startOfDay(r, tz);
  const nextDaySeed = new Date(start.getTime() + 36 * 3600000);
  const end = new Date(startOfDay(nextDaySeed, tz).getTime() - 1);
  return { start, end };
}
function refMetric(goal: LifeGoal, qualifying: LifeEvent[], tz: string): number {
  if (goal.metric === "count") return qualifying.length;
  if (goal.metric === "days") {
    const s = new Set<string>();
    for (const e of qualifying) s.add(dayKey(e.timestamp, tz));
    return s.size;
  }
  let total = 0;
  for (const e of qualifying) {
    for (const en of e.entries) if (en.type === "number" && en.unit === goal.unit) total += en.value;
  }
  return total;
}
function refMet(kind: LifeGoal["kind"], v: number, t: number) {
  return kind === "at_most" ? v <= t : v >= t;
}
function refEvaluate(goal: LifeGoal, events: LifeEvent[], trackables: LifeManifestTrackable[], tz: string, refDate: Date) {
  const subjectIds = "thing" in goal.scope
    ? new Set([goal.scope.thing])
    : new Set(trackables.filter((tt) => tt.group === (goal.scope as { group: string }).group && (!tt.hidden || tt.id === (goal.scope as { group: string }).group)).map((tt) => tt.id));
  const qual = (s: Date, e: Date) => events.filter((ev2) => subjectIds.has(ev2.subjectId) && ev2.timestamp >= s && ev2.timestamp <= e);
  const { start, end } = refPeriodBounds(goal.period, refDate, tz);
  const value = refMetric(goal, qual(start, end), tz);
  let earliest: Date | undefined;
  for (const e of events) if (subjectIds.has(e.subjectId) && (!earliest || e.timestamp < earliest)) earliest = e.timestamp;
  const earliestStart = earliest ? refPeriodBounds(goal.period, earliest, tz).start : undefined;
  let streak = 0;
  let cursor = refDate;
  for (let i = 0; i < MAX_STREAK_LOOKBACK; i++) {
    const b = refPeriodBounds(goal.period, cursor, tz);
    if (!earliestStart || b.start < earliestStart) break;
    if (!refMet(goal.kind, refMetric(goal, qual(b.start, b.end), tz), goal.target)) break;
    streak += 1;
    const z = new Date(cursor.getTime());
    z.setUTCDate(z.getUTCDate() - (goal.period === "week" ? 7 : 1));
    cursor = z;
  }
  return { value, met: refMet(goal.kind, value, goal.target), streak };
}

describe("evaluateGoal — brute-force oracle (old == new)", () => {
  // Randomized-but-seeded inputs across metrics/kinds/periods. The reference
  // re-filters per period; the real impl buckets once. They must agree on
  // value, met, and streak for every case.
  const tz = "America/Los_Angeles";
  const goals: LifeGoal[] = [
    { id: "a", label: "a", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 1, period: "day" },
    { id: "b", label: "b", scope: { thing: "floss" }, kind: "at_least", metric: "count", target: 2, period: "day" },
    { id: "c", label: "c", scope: { thing: "water" }, kind: "at_least", metric: "sum", unit: "oz", target: 40, period: "day" },
    { id: "d", label: "d", scope: { thing: "water" }, kind: "at_most", metric: "sum", unit: "drinks", target: 2, period: "day" },
    { id: "e", label: "e", scope: { group: "exercise" }, kind: "frequency", metric: "days", target: 3, period: "week" },
    { id: "f", label: "f", scope: { group: "exercise" }, kind: "at_least", metric: "count", target: 4, period: "week" },
    { id: "g", label: "g", scope: { thing: "floss" }, kind: "frequency", metric: "days", target: 2, period: "week" },
  ];

  // Deterministic PRNG so failures are reproducible.
  function mulberry32(seed: number) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("matches the reference across 40 randomized event sets", () => {
    const rng = mulberry32(12345);
    const subjects = ["floss", "water", "run", "walk", "yoga"];
    const ref = at(2026, 6, 20);
    for (let trial = 0; trial < 40; trial++) {
      const n = Math.floor(rng() * 30);
      const events: LifeEvent[] = [];
      for (let i = 0; i < n; i++) {
        const subj = subjects[Math.floor(rng() * subjects.length)];
        // spread across ~40 days back, random hour
        const dayBack = Math.floor(rng() * 40);
        const hour = Math.floor(rng() * 24);
        const when = new Date(ref.getTime() - dayBack * 86400000);
        when.setUTCHours(hour);
        const entries: LifeEntry[] = [
          { name: "amount", type: "number", value: Math.floor(rng() * 30), unit: "oz" },
          { name: "drinks", type: "number", value: Math.floor(rng() * 4), unit: "drinks" },
          { name: "count", type: "number", value: 1, unit: "ct" },
          { name: "duration", type: "number", value: 30, unit: "min" },
        ];
        events.push(ev(subj, entries, when));
      }
      for (const goal of goals) {
        const got = evaluateGoal(goal, events, TRACKABLES, tz, ref);
        const want = refEvaluate(goal, events, TRACKABLES, tz, ref);
        const ctx = `trial=${trial} goal=${goal.id}`;
        expect(got.value, `value ${ctx}`).toBe(want.value);
        expect(got.met, `met ${ctx}`).toBe(want.met);
        expect(got.streak, `streak ${ctx}`).toBe(want.streak);
      }
    }
  });
});
