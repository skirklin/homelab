import { describe, it, expect } from "vitest";
import { groupTaskIds, leafTasksOnly } from "./task-tree";

describe("groupTaskIds", () => {
  it("is empty for no tasks", () => {
    expect(groupTaskIds([])).toEqual(new Set());
  });

  it("is empty when every task is a childless root", () => {
    expect(groupTaskIds([{ parentId: "" }, { parentId: null }, {}])).toEqual(new Set());
  });

  it("treats a task referenced as a parent as a group", () => {
    const ids = groupTaskIds([{ parentId: "a" }, { parentId: "b" }, { parentId: "a" }]);
    expect(ids).toEqual(new Set(["a", "b"]));
  });

  it('does not treat "" / null parentId as a parent of anything', () => {
    expect(groupTaskIds([{ parentId: "" }, { parentId: null }])).toEqual(new Set());
  });
});

describe("leafTasksOnly", () => {
  const t = (id: string, parentId?: string | null) => ({ id, parentId });

  it("returns childless tasks as leaves", () => {
    const tasks = [t("a"), t("b"), t("c")];
    expect(leafTasksOnly(tasks).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("drops a parent that has a child", () => {
    // group is parent of child; group is dropped, child kept.
    const tasks = [t("group"), t("child", "group")];
    expect(leafTasksOnly(tasks).map((x) => x.id)).toEqual(["child"]);
  });

  it("is STRUCTURAL: a parent is still a group even if its child is completed/cleared", () => {
    // The filter is over identity only — completion state is not consulted here.
    type Task = { id: string; parentId?: string | null; completed?: boolean; cleared?: boolean };
    const tasks: Task[] = [
      { id: "group" },
      { id: "child", parentId: "group", completed: true, cleared: true },
    ];
    expect(leafTasksOnly(tasks).map((x) => x.id)).toEqual(["child"]);
  });

  it("keeps roots whose parentId is empty (a root with no children is a leaf)", () => {
    const tasks = [t("root", ""), t("leaf")];
    expect(leafTasksOnly(tasks).map((x) => x.id)).toEqual(["root", "leaf"]);
  });

  it("returns [] for empty input", () => {
    expect(leafTasksOnly([])).toEqual([]);
  });
});
