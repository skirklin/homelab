/**
 * Shared leaf/group rule for the unified task tree.
 *
 * A task is a GROUP iff some other task has it as parent; it is a LEAF
 * otherwise. This is the single source of truth for that distinction —
 * co-located with `upkeep-urgency.ts` so the surfaces that should show only
 * actionable LEAVES (the notification crons and life's morning block today)
 * derive leaf-ness through here rather than re-spelling a similar-but-different
 * rule that can drift.
 */

/**
 * The set of task ids that are some task's parent — the GROUP / container
 * nodes. A task is a LEAF iff its id is NOT in this set. STRUCTURAL: a task
 * with ANY child counts as a group even if every child is completed/cleared.
 *
 * Single source of truth for the leaf/group distinction. Every surface that
 * should show only actionable LEAVES — the notification crons and the life
 * morning block today — derives leaf-ness through here so they can't drift
 * into similar-but-different rules.
 */
export function groupTaskIds(tasks: Array<{ parentId?: string | null }>): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    // "" / null parentId = a root; it points at nothing, so it makes nothing a group.
    if (t.parentId) ids.add(t.parentId);
  }
  return ids;
}

/** Filter a task collection down to LEAVES (drops group/container nodes). */
export function leafTasksOnly<T extends { id: string; parentId?: string | null }>(tasks: T[]): T[] {
  const groupIds = groupTaskIds(tasks);
  return tasks.filter((t) => !groupIds.has(t.id));
}
