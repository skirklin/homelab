import { describe, it, expect } from "vitest";
import { urgencyOf, isActionableOneShot, type UrgencyTask } from "./upkeep-urgency";

/** Build a one_shot UrgencyTask. `deadline` null = someday. */
function oneShot(overrides: {
  deadline?: Date | null;
  leadDays?: number;
  completed?: boolean;
  cleared?: boolean;
  snoozedUntil?: Date | null;
} = {}): UrgencyTask {
  const deadline = overrides.deadline ?? null;
  return {
    taskType: "one_shot",
    schedule: deadline ? { kind: "dated", deadline, leadDays: overrides.leadDays ?? 0 } : { kind: "someday" },
    completed: overrides.completed ?? false,
    cleared: overrides.cleared ?? false,
    snoozedUntil: overrides.snoozedUntil ?? null,
  };
}

function recurring(overrides: {
  freqDays?: number;
  lastCompleted?: Date | null;
  snoozedUntil?: Date | null;
} = {}): UrgencyTask {
  return {
    taskType: "recurring",
    frequency: { value: overrides.freqDays ?? 1, unit: "days" },
    lastCompleted: overrides.lastCompleted ?? null,
    snoozedUntil: overrides.snoozedUntil ?? null,
  };
}

/** Local-midnight date `n` whole days from `now` (negative = past). */
function daysFromToday(n: number, now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12, 0, 0);
}

describe("urgencyOf — one-shot overdue vs someday (the old 'asap' split)", () => {
  const now = new Date();

  it("undated one_shot → someday (was conflated under 'asap')", () => {
    expect(urgencyOf(oneShot({ deadline: null }), now)).toEqual({ kind: "someday" });
  });

  it("dated one_shot in the past → overdue with positive day count", () => {
    expect(urgencyOf(oneShot({ deadline: daysFromToday(-3, now) }), now)).toEqual({
      kind: "overdue",
      days: 3,
    });
  });

  it("one_shot due today → dueToday, NOT overdue/someday", () => {
    expect(urgencyOf(oneShot({ deadline: daysFromToday(0, now) }), now)).toEqual({ kind: "dueToday" });
  });

  it("one_shot due within a week → dueSoon with the day count", () => {
    expect(urgencyOf(oneShot({ deadline: daysFromToday(3, now) }), now)).toEqual({
      kind: "dueSoon",
      days: 3,
    });
  });

  it("one_shot far in the future → later", () => {
    expect(urgencyOf(oneShot({ deadline: daysFromToday(30, now) }), now)).toEqual({
      kind: "later",
      days: 30,
    });
  });
});

describe("urgencyOf — snooze folded in", () => {
  const now = new Date();

  it("a snoozed (future) task is always snoozed, regardless of an overdue deadline", () => {
    const until = daysFromToday(2, now);
    const u = urgencyOf(oneShot({ deadline: daysFromToday(-5, now), snoozedUntil: until }), now);
    expect(u).toEqual({ kind: "snoozed", until });
  });

  it("an expired snooze does NOT mask urgency — overdue still surfaces", () => {
    expect(
      urgencyOf(oneShot({ deadline: daysFromToday(-5, now), snoozedUntil: daysFromToday(-1, now) }), now),
    ).toEqual({ kind: "overdue", days: 5 });
  });

  it("a snoozed undated todo is snoozed, not someday", () => {
    const until = daysFromToday(2, now);
    expect(urgencyOf(oneShot({ deadline: null, snoozedUntil: until }), now)).toEqual({
      kind: "snoozed",
      until,
    });
  });
});

describe("urgencyOf — recurring never produces overdue/someday", () => {
  const now = new Date();

  it("never-done recurring → dueToday (immediately due, not someday)", () => {
    expect(urgencyOf(recurring({ lastCompleted: null }), now)).toEqual({ kind: "dueToday" });
  });

  it("recurring completed long ago (overdue by frequency) → dueToday, not overdue", () => {
    expect(
      urgencyOf(recurring({ freqDays: 1, lastCompleted: daysFromToday(-10, now) }), now),
    ).toEqual({ kind: "dueToday" });
  });

  it("recurring not yet due → dueSoon/later, never overdue/someday", () => {
    const u = urgencyOf(recurring({ freqDays: 30, lastCompleted: daysFromToday(-1, now) }), now);
    expect(u.kind === "dueSoon" || u.kind === "later").toBe(true);
  });
});

describe("urgencyOf — now is a parameter (no clock drift)", () => {
  it("evaluating against a fixed past `now` reclassifies the same task", () => {
    // A task dated 2026-06-19. Against a `now` of the same day → dueToday;
    // against a `now` two days later → overdue. Proves the projection uses the
    // passed clock, not the wall clock.
    const deadline = new Date(2026, 5, 19, 12, 0, 0);
    const task = oneShot({ deadline });
    expect(urgencyOf(task, new Date(2026, 5, 19, 8, 0, 0))).toEqual({ kind: "dueToday" });
    expect(urgencyOf(task, new Date(2026, 5, 21, 8, 0, 0))).toEqual({ kind: "overdue", days: 2 });
  });
});

describe("isActionableOneShot", () => {
  const now = new Date();

  it("open one_shot (not completed/cleared/snoozed) → true", () => {
    expect(isActionableOneShot(oneShot(), now)).toBe(true);
  });

  it("recurring task → false (gate is one_shot only)", () => {
    expect(isActionableOneShot(recurring(), now)).toBe(false);
  });

  it("completed one_shot → false", () => {
    expect(isActionableOneShot(oneShot({ completed: true }), now)).toBe(false);
  });

  it("cleared one_shot → false", () => {
    expect(isActionableOneShot(oneShot({ cleared: true }), now)).toBe(false);
  });

  it("snoozed one_shot (snoozedUntil in the future) → false", () => {
    expect(isActionableOneShot(oneShot({ snoozedUntil: daysFromToday(2, now) }), now)).toBe(false);
  });

  it("expired snooze (snoozedUntil in the past) → true", () => {
    expect(isActionableOneShot(oneShot({ snoozedUntil: daysFromToday(-2, now) }), now)).toBe(true);
  });

  it("ignores deadline and urgency — a far-future open todo is still actionable", () => {
    expect(isActionableOneShot(oneShot({ deadline: daysFromToday(30, now) }), now)).toBe(true);
  });
});
