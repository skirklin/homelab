import { describe, it, expect } from "vitest";
import { getTasksByUrgency, childrenByParentId, subtreeIds } from "./selectors";
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

// Brute-force reference impls = the pre-refactor logic, used to prove the
// O(n)-scan replacements return identical results.
function refSiblings(tasks: Task[], parentId: string): Task[] {
  return tasks.filter((t) => t.parentId === parentId);
}
function refSubtree(tasks: Task[], rootId: string): string[] {
  if (!tasks.find((t) => t.id === rootId)) return [];
  const result = [rootId];
  const stack = [rootId];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const t of tasks) {
      if (t.parentId === pid) {
        result.push(t.id);
        stack.push(t.id);
      }
    }
  }
  return result;
}

describe("childrenByParentId", () => {
  it("preserves sibling order identical to .filter(parentId === pid)", () => {
    // Deliberately out of position order to prove grouping is by array order,
    // not by position (matching the old `.filter` which never sorted).
    const tasks = [
      recurring({ id: "a", parentId: "", position: 2 }),
      recurring({ id: "b", parentId: "p", position: 5 }),
      recurring({ id: "c", parentId: "", position: 1 }),
      recurring({ id: "d", parentId: "p", position: 0 }),
      recurring({ id: "e", parentId: "", position: 9 }),
    ];
    const map = childrenByParentId(tasks);
    expect((map.get("") ?? []).map((t) => t.id)).toEqual(
      refSiblings(tasks, "").map((t) => t.id),
    );
    expect((map.get("p") ?? []).map((t) => t.id)).toEqual(
      refSiblings(tasks, "p").map((t) => t.id),
    );
    // Concretely: insertion order, not position order.
    expect((map.get("") ?? []).map((t) => t.id)).toEqual(["a", "c", "e"]);
    expect((map.get("p") ?? []).map((t) => t.id)).toEqual(["b", "d"]);
  });

  it("returns no bucket for a parent with no children", () => {
    const map = childrenByParentId([recurring({ id: "solo" })]);
    expect(map.get("nope")).toBeUndefined();
  });
});

describe("subtreeIds", () => {
  const tasks = [
    recurring({ id: "root", parentId: "" }),
    recurring({ id: "c1", parentId: "root" }),
    recurring({ id: "c2", parentId: "root" }),
    recurring({ id: "g1", parentId: "c1" }),
    recurring({ id: "g2", parentId: "c1" }),
    recurring({ id: "other", parentId: "" }),
  ];
  const childrenMap = childrenByParentId(tasks);
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  it("returns the same id set as a brute-force walk", () => {
    for (const id of [...tasks.map((t) => t.id), "missing"]) {
      expect([...subtreeIds(childrenMap, tasksById, id)].sort()).toEqual(
        [...refSubtree(tasks, id)].sort(),
      );
    }
  });

  it("includes itself + all descendants", () => {
    expect([...subtreeIds(childrenMap, tasksById, "root")].sort()).toEqual(
      ["c1", "c2", "g1", "g2", "root"],
    );
  });

  it("returns [] for an unknown root", () => {
    expect(subtreeIds(childrenMap, tasksById, "missing")).toEqual([]);
  });
});
