import { describe, it, expect } from "vitest";
import { getUrgencyLevel, isActionableOneShot, type UrgencyTask } from "./upkeep-urgency";

/** Build a UrgencyTask with sane defaults; override per case. */
function task(overrides: Partial<UrgencyTask> = {}): UrgencyTask {
  return {
    taskType: "one_shot",
    frequency: { value: 1, unit: "days" },
    lastCompleted: null,
    deadline: null,
    snoozedUntil: null,
    completed: false,
    cleared: false,
    ...overrides,
  };
}

/** Local-midnight date `n` whole days from today (negative = past). */
function daysFromToday(n: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12, 0, 0);
}

describe("getUrgencyLevel — asap bucket", () => {
  it("one_shot with NO deadline → asap (was silently 'later')", () => {
    expect(getUrgencyLevel(task({ taskType: "one_shot", deadline: null }))).toBe("asap");
  });

  it("one_shot with a deadline in the past (overdue) → asap (was 'today')", () => {
    expect(getUrgencyLevel(task({ taskType: "one_shot", deadline: daysFromToday(-3) }))).toBe("asap");
  });

  it("one_shot due today (diff 0) → today, NOT asap", () => {
    expect(getUrgencyLevel(task({ taskType: "one_shot", deadline: daysFromToday(0) }))).toBe("today");
  });

  it("one_shot with a future deadline within a week → thisWeek", () => {
    expect(getUrgencyLevel(task({ taskType: "one_shot", deadline: daysFromToday(3) }))).toBe("thisWeek");
  });

  it("one_shot with a far-future deadline → later", () => {
    expect(getUrgencyLevel(task({ taskType: "one_shot", deadline: daysFromToday(30) }))).toBe("later");
  });

  it("recurring tasks are never asap — never-done is still today", () => {
    expect(
      getUrgencyLevel(task({ taskType: "recurring", lastCompleted: null, deadline: null })),
    ).toBe("today");
  });

  it("recurring overdue (last completed long ago) is today, not asap", () => {
    expect(
      getUrgencyLevel(
        task({
          taskType: "recurring",
          frequency: { value: 1, unit: "days" },
          lastCompleted: daysFromToday(-10),
        }),
      ),
    ).toBe("today");
  });

  it("recurring not yet due → thisWeek/later, never asap", () => {
    const level = getUrgencyLevel(
      task({
        taskType: "recurring",
        frequency: { value: 30, unit: "days" },
        lastCompleted: daysFromToday(-1),
      }),
    );
    expect(level).not.toBe("asap");
  });
});

describe("isActionableOneShot", () => {
  it("open one_shot (not completed/cleared/snoozed) → true", () => {
    expect(isActionableOneShot(task({ taskType: "one_shot" }))).toBe(true);
  });

  it("recurring task → false (gate is one_shot only)", () => {
    expect(isActionableOneShot(task({ taskType: "recurring" }))).toBe(false);
  });

  it("completed one_shot → false", () => {
    expect(isActionableOneShot(task({ taskType: "one_shot", completed: true }))).toBe(false);
  });

  it("cleared one_shot → false", () => {
    expect(isActionableOneShot(task({ taskType: "one_shot", cleared: true }))).toBe(false);
  });

  it("snoozed one_shot (snoozedUntil in the future) → false", () => {
    expect(
      isActionableOneShot(task({ taskType: "one_shot", snoozedUntil: daysFromToday(2) })),
    ).toBe(false);
  });

  it("expired snooze (snoozedUntil in the past) → true", () => {
    expect(
      isActionableOneShot(task({ taskType: "one_shot", snoozedUntil: daysFromToday(-2) })),
    ).toBe(true);
  });

  it("ignores deadline and urgency — a far-future open todo is still actionable", () => {
    expect(
      isActionableOneShot(task({ taskType: "one_shot", deadline: daysFromToday(30) })),
    ).toBe(true);
  });
});
