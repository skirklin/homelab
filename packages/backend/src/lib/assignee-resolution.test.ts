import { describe, it, expect } from "vitest";
import { resolveAssignees, type AssigneeNode } from "./assignee-resolution";

// Build a node with sensible defaults; pass `path` to exercise the path-based
// ancestor walk, omit it to exercise the parentId fallback.
function node(p: Partial<AssigneeNode> & { id: string }): AssigneeNode {
  return {
    parentId: "",
    assignees: [],
    createdBy: "",
    ...p,
  };
}

function byId(...nodes: AssigneeNode[]): Map<string, AssigneeNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe("resolveAssignees — mirrors resolveNotifyRecipients", () => {
  it("explicit assignees win over everything (inherited: false)", () => {
    const root = node({ id: "root", path: "root", assignees: ["userA"], createdBy: "userZ" });
    const child = node({
      id: "child",
      parentId: "root",
      path: "root/child",
      assignees: ["userB"],
      createdBy: "userZ",
    });
    const r = resolveAssignees(child, byId(root, child));
    expect(r).toEqual({ assignees: ["userB"], inherited: false });
  });

  it("inherits the nearest assigned ancestor when own assignees empty", () => {
    const root = node({ id: "root", path: "root", assignees: ["userA"], createdBy: "userZ" });
    const mid = node({
      id: "mid",
      parentId: "root",
      path: "root/mid",
      assignees: ["userB"],
      createdBy: "userZ",
    });
    const leaf = node({
      id: "leaf",
      parentId: "mid",
      path: "root/mid/leaf",
      assignees: [],
      createdBy: "userZ",
    });
    // Nearest assigned ancestor is `mid` (userB), not `root` (userA).
    const r = resolveAssignees(leaf, byId(root, mid, leaf));
    expect(r).toEqual({ assignees: ["userB"], inherited: true });
  });

  it("skips unassigned ancestors to find the nearest assigned one", () => {
    const root = node({ id: "root", path: "root", assignees: ["userA"], createdBy: "userZ" });
    const mid = node({ id: "mid", parentId: "root", path: "root/mid", assignees: [], createdBy: "userZ" });
    const leaf = node({ id: "leaf", parentId: "mid", path: "root/mid/leaf", assignees: [], createdBy: "userZ" });
    const r = resolveAssignees(leaf, byId(root, mid, leaf));
    expect(r).toEqual({ assignees: ["userA"], inherited: true });
  });

  it("falls to created_by when no ancestor is assigned (inherited: true)", () => {
    const root = node({ id: "root", path: "root", assignees: [], createdBy: "userZ" });
    const leaf = node({ id: "leaf", parentId: "root", path: "root/leaf", assignees: [], createdBy: "userY" });
    const r = resolveAssignees(leaf, byId(root, leaf));
    // Floor is the task's OWN created_by, not the root's.
    expect(r).toEqual({ assignees: ["userY"], inherited: true });
  });

  it("preserves multiple explicit assignees and dedupes", () => {
    const t = node({ id: "t", path: "t", assignees: ["userA", "userB", "userA"], createdBy: "userZ" });
    const r = resolveAssignees(t, byId(t));
    expect(r).toEqual({ assignees: ["userA", "userB"], inherited: false });
  });

  it("inherits multiple assignees from an ancestor", () => {
    const root = node({ id: "root", path: "root", assignees: ["userA", "userB"], createdBy: "userZ" });
    const leaf = node({ id: "leaf", parentId: "root", path: "root/leaf", assignees: [], createdBy: "userZ" });
    const r = resolveAssignees(leaf, byId(root, leaf));
    expect(r).toEqual({ assignees: ["userA", "userB"], inherited: true });
  });

  it("returns empty (no chip) for orphaned legacy data with no created_by", () => {
    const t = node({ id: "t", path: "t", assignees: [], createdBy: "" });
    const r = resolveAssignees(t, byId(t));
    expect(r).toEqual({ assignees: [], inherited: true });
  });

  it("walks parentId links when path is absent", () => {
    const root = node({ id: "root", assignees: ["userA"], createdBy: "userZ" });
    const leaf = node({ id: "leaf", parentId: "root", assignees: [], createdBy: "userZ" });
    const r = resolveAssignees(leaf, byId(root, leaf));
    expect(r).toEqual({ assignees: ["userA"], inherited: true });
  });

  it("does not loop forever on a corrupt parentId cycle", () => {
    const a = node({ id: "a", parentId: "b", assignees: [], createdBy: "" });
    const b = node({ id: "b", parentId: "a", assignees: [], createdBy: "" });
    // No assigned ancestor, no created_by → empty, but crucially it terminates.
    const r = resolveAssignees(a, byId(a, b));
    expect(r).toEqual({ assignees: [], inherited: true });
  });

  it("a root task with explicit assignees is explicit", () => {
    const root = node({ id: "root", path: "root", assignees: ["userA"], createdBy: "userZ" });
    const r = resolveAssignees(root, byId(root));
    expect(r).toEqual({ assignees: ["userA"], inherited: false });
  });

  it("a root task with no assignees floors to its own created_by", () => {
    const root = node({ id: "root", path: "root", assignees: [], createdBy: "userZ" });
    const r = resolveAssignees(root, byId(root));
    expect(r).toEqual({ assignees: ["userZ"], inherited: true });
  });
});
