/**
 * Client-side mirror of the server's `resolveNotifyRecipients` cascade
 * (services/api/src/lib/notifications/recipients.ts) — used by the task UIs to
 * DISPLAY who a task is effectively assigned to, including inheritance.
 *
 * The server resolves a task's notify recipients via a CSS-cascade `inherit`
 * walk: the task's own non-empty `assignees` wins; else the nearest ancestor up
 * the `parent_id` / `path` chain with a non-empty `assignees`; else the floor of
 * the task's own `created_by`. This module reproduces that EXACTLY against the
 * in-memory task tree the outliner already holds, so the chip a user sees and
 * the person who actually gets pinged never disagree.
 *
 * Difference from the server fn: the server takes an `ancestorsById` map + a
 * `listOwners` legacy fallback (for pre-`created_by` tasks). Clients always have
 * the full task set in memory, so we walk it directly; the list-owners fallback
 * is intentionally dropped — modern tasks always carry `created_by`, and a
 * displayed "assigned to nobody" would only ever come from genuinely-orphaned
 * legacy data, which the UI renders as no chip rather than a guess.
 */

/** Minimal task shape the resolver reads. Both `@homelab/backend`'s `Task` and
 *  the upkeep app's local `Task` satisfy this structurally. */
export interface AssigneeNode {
  id: string;
  /** Direct parent id, or "" for a root task. */
  parentId: string;
  /** Materialized root→self id chain, `/`-separated, self-inclusive. Optional —
   *  when present it's the authoritative ancestor order; otherwise we fall back
   *  to walking `parentId` links. */
  path?: string;
  /** Multi-relation set of assigned users — the sole notification driver. */
  assignees: string[];
  /** Immutable provenance: who created the task. The cascade's terminal floor. */
  createdBy: string;
}

export interface ResolvedAssignees {
  /** Effective assignee ids (deduped, order preserved). */
  assignees: string[];
  /** True when these were NOT set explicitly on the task — i.e. they came from
   *  an ancestor or from the `created_by` floor. Drives the muted/ghost style. */
  inherited: boolean;
}

const nonEmpty = (v: readonly string[] | undefined): string[] | null =>
  Array.isArray(v) && v.length > 0 ? [...v] : null;

/**
 * Resolve a task's effective assignees for display.
 *
 * Order (mirrors `resolveNotifyRecipients`):
 *   1. the task's own non-empty `assignees` → explicit (inherited: false);
 *   2. else the nearest ancestor (self-excluded), walking nearest→farthest,
 *      with a non-empty `assignees` → inherited: true;
 *   3. else the task's own `created_by` → inherited: true;
 *   4. else empty (orphaned legacy data) → inherited: true, no assignees.
 *
 * @param task      the task to resolve
 * @param tasksById every task in the same tree, keyed by id (must include
 *                  ancestors; the task itself need not be present)
 */
export function resolveAssignees(
  task: AssigneeNode,
  tasksById: Map<string, AssigneeNode>,
): ResolvedAssignees {
  const own = nonEmpty(task.assignees);
  if (own) return { assignees: [...new Set(own)], inherited: false };

  for (const ancestor of ancestorsNearestFirst(task, tasksById)) {
    const v = nonEmpty(ancestor.assignees);
    if (v) return { assignees: [...new Set(v)], inherited: true };
  }

  if (task.createdBy) return { assignees: [task.createdBy], inherited: true };

  return { assignees: [], inherited: true };
}

/**
 * Proper ancestors of `task`, nearest first. Prefers the materialized `path`
 * (root→self, so ancestors are every segment but the last, reversed); falls back
 * to walking `parentId` links when `path` is absent. A cycle/missing-link guard
 * caps the walk at the map size.
 */
function* ancestorsNearestFirst(
  task: AssigneeNode,
  tasksById: Map<string, AssigneeNode>,
): Generator<AssigneeNode> {
  if (task.path) {
    const segments = task.path.split("/").filter(Boolean);
    // Last segment is self; proper ancestors are the rest, nearest = closest to self.
    for (let i = segments.length - 2; i >= 0; i--) {
      const anc = tasksById.get(segments[i]);
      if (anc) yield anc;
    }
    return;
  }

  // No path: walk parentId links. Guard against cycles with a visited set.
  const seen = new Set<string>([task.id]);
  let parentId = task.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const anc = tasksById.get(parentId);
    if (!anc) break;
    yield anc;
    parentId = anc.parentId;
  }
}
