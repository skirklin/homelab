/**
 * Shared notify-recipient cascade for task notifications.
 *
 * Both task-notification crons (one-shot deadline reminders in deadlines.ts and
 * recurring chore reminders in upkeep.ts) resolve who to notify the SAME way:
 * an `inherit`-strategy cascade over the task's ancestor `path` chain. The
 * nearest ancestor with an explicit `assignees` set wins, the node's own value
 * overrides ancestors, and the terminal floor is the task's own `created_by` —
 * deliberately NOT the root list owners.
 *
 * `assignees` (formerly `notify_users`) is the SOLE notification driver:
 * whoever a task is assigned to is who gets reminded. `created_by` stays as
 * immutable provenance and as the cascade's terminal floor.
 *
 * The old rule was union(list.owners, notify_users), which pinged every owner of
 * a shared list regardless of who the task was for (e.g. Angela got Scott's
 * trip-prep / chore reminders). This module is the single source of truth for
 * the fixed behavior so neither cron can drift back to the union bug.
 */
import type PocketBase from "pocketbase";

/** Minimal shape of a task record needed to resolve its notify recipients. */
export interface NotifyNode {
  /** Multi-relation set of assigned users — the sole notification driver. */
  assignees?: string[] | null;
  /** Materialized ancestor-id chain, `/`-separated, SELF-INCLUSIVE (last
   *  segment is the node's own id). Root node → path === own id. */
  path?: string | null;
  /** Single-user relation (maxSelect:1) → string id, or "" / undefined. */
  created_by?: string | null;
}

/**
 * Resolve the notify-recipient set for one due task via the `inherit` cascade.
 *
 * @param task          the due task record
 * @param ancestorsById ancestor task records keyed by id (need NOT include the
 *                      task itself; only proper ancestors are consulted). Only
 *                      `assignees` is read off them.
 * @param listOwners    fallback ONLY for legacy tasks with no chain config and
 *                      no `created_by` (predating created_by stamping).
 *
 * Resolution order (CSS-cascade `inherit`):
 *   1. nearest node on the root→self chain (self first, then closest ancestor,
 *      …) with a NON-EMPTY explicit `assignees` set wins;
 *   2. else the task's own `created_by` (single user) — the floor that fixes
 *      the bug: an un-configured task notifies its creator, not all owners;
 *   3. else (legacy: no created_by either) the list owners, to preserve old
 *      behavior rather than silently notifying nobody.
 */
export function resolveNotifyRecipients(
  task: NotifyNode,
  ancestorsById: Map<string, NotifyNode>,
  listOwners: string[],
): string[] {
  const nonEmpty = (v?: string[] | null): string[] | null =>
    Array.isArray(v) && v.length > 0 ? v : null;

  // Self overrides ancestors.
  const own = nonEmpty(task.assignees);
  if (own) return [...new Set(own)];

  // Walk ancestors nearest → farthest. `path` is root→…→self, so proper
  // ancestor ids are every segment except the last (self). Reverse to get
  // nearest-first.
  const segments = (task.path || "").split("/").filter(Boolean);
  const ancestorIds = segments.slice(0, -1).reverse();
  for (const id of ancestorIds) {
    const anc = ancestorsById.get(id);
    const v = anc && nonEmpty(anc.assignees);
    if (v) return [...new Set(v)];
  }

  // Terminal floor: the task's creator (single user).
  if (task.created_by) return [task.created_by];

  // Legacy floor: tasks predating created_by stamping fall back to owners
  // rather than notifying nobody.
  return [...new Set(listOwners)];
}

/**
 * Batch-fetch every proper-ancestor task referenced by any of `tasks`' `path`
 * chains, returning a `{id → {assignees}}` map for resolveNotifyRecipients.
 *
 * Ancestors (containers) are usually NOT themselves in the due set, so this is
 * one getFullList instead of an N+1 per-task walk. Reads only `assignees`
 * (the sole field the cascade consults on ancestors).
 */
export async function fetchAncestorsByPath(
  pb: PocketBase,
  tasks: { path?: string | null }[],
): Promise<Map<string, NotifyNode>> {
  const ancestorIds = new Set<string>();
  for (const task of tasks) {
    const segments = (task.path || "").split("/").filter(Boolean);
    for (const id of segments.slice(0, -1)) ancestorIds.add(id);
  }

  const ancestorsById = new Map<string, NotifyNode>();
  if (ancestorIds.size === 0) return ancestorsById;

  const ancestors = await pb.collection("tasks").getFullList({
    filter: [...ancestorIds].map((id) => pb.filter("id = {:id}", { id })).join(" || "),
    fields: "id,assignees",
    $autoCancel: false,
  });
  for (const a of ancestors) ancestorsById.set(a.id, a as NotifyNode);
  return ancestorsById;
}

/**
 * Fetch the set of task ids that are a PARENT of at least one other task —
 * the "group"/container nodes. Notifications target only LEAF tasks
 * (actionable todos), never the containers that organize them, so both crons
 * subtract this set from their due list. `parent_id` is a plain text field
 * (not a relation) defaulting to "" for roots, so the cheapest way to know
 * leaf-ness is one getFullList of just the parent_id column, deduped into a
 * Set. A task with ANY child (of any task_type, completed or not) is a group.
 */
export async function fetchParentIds(pb: PocketBase): Promise<Set<string>> {
  const rows = await pb.collection("tasks").getFullList({
    filter: 'parent_id != ""',
    fields: "parent_id",
    $autoCancel: false,
  });
  const ids = new Set<string>();
  for (const r of rows) if (r.parent_id) ids.add(r.parent_id as string);
  return ids;
}
