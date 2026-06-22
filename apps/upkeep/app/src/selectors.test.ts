import { describe, it, expect } from "vitest";
import { getTasksByUrgency } from "./selectors";
import type { RecurringTask, Task } from "./types";
import type { UpkeepState } from "./upkeep-context";

function recurring(overrides: Partial<RecurringTask> & { id: string }): RecurringTask {
  return {
    taskType: "recurring",
    parentId: "",
    path: overrides.id,
    position: 0,
    name: overrides.id,
    description: "",
    snoozedUntil: null,
    assignees: [],
    createdBy: "u1",
    tags: [],
    collapsed: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    frequency: { value: 1, unit: "weeks" },
    lastCompleted: null,
    ...overrides,
  };
}

function stateOf(tasks: Task[]): UpkeepState {
  return {
    userSlugs: {},
    list: null,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    completions: [],
    loading: false,
  };
}

function allBucketed(grouped: ReturnType<typeof getTasksByUrgency>): Task[] {
  return [...grouped.today, ...grouped.thisWeek, ...grouped.later, ...grouped.snoozed];
}

describe("getTasksByUrgency", () => {
  it("excludes a recurring container (has a child) but keeps its leaf child", () => {
    const container = recurring({ id: "container" });
    const child = recurring({ id: "child", parentId: "container", path: "container/child" });
    const grouped = getTasksByUrgency(stateOf([container, child]));
    const ids = allBucketed(grouped).map((t) => t.id);
    expect(ids).toContain("child");
    expect(ids).not.toContain("container");
  });

  it("keeps a childless recurring task (it's a leaf)", () => {
    const solo = recurring({ id: "solo" });
    const grouped = getTasksByUrgency(stateOf([solo]));
    const ids = allBucketed(grouped).map((t) => t.id);
    expect(ids).toContain("solo");
  });
});
