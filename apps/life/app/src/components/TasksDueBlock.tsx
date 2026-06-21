/**
 * Read-only "Today's upkeep" block — the renderer for a View's `tasks_due`
 * item. Glance-able context, not interactive — no checkboxes, no complete/snooze
 * affordances. Empty state renders nothing (no flicker, no "Nothing due"
 * message). Rendered as a lead block above the first capture step (today it
 * appears in the morning View; it is driven by the `tasks_due` item, not by a
 * hardcoded session id).
 *
 * Aggregates today's tasks across ALL household lists in the user's slug map.
 * The surface is a "what's due today" union — if you have multiple lists they're
 * all here. Today there's typically just one list (`home`), but the union is the
 * right shape for aggregation.
 */
import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { useAuth, useUpkeepBackend, useUserBackend } from "@kirkl/shared";
import {
  urgencyOf,
  isActionableOneShot,
  type Task as BackendTask,
} from "@homelab/backend";

/** The dated-schedule deadline, or null for recurring / someday tasks. */
function taskDeadline(task: BackendTask): Date | null {
  return task.taskType === "one_shot" && task.schedule.kind === "dated"
    ? task.schedule.deadline
    : null;
}

/**
 * Tiny deadline formatter. Inlined here rather than importing upkeep's
 * formatDeadline (no life→upkeep cross-app import) or promoting it to
 * @homelab/backend for a single extra consumer.
 */
function formatDeadline(deadline: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDateOnly = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  const diffDays = Math.floor((dueDateOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < -1) return `${Math.abs(diffDays)} days overdue`;
  if (diffDays === -1) return "1 day overdue";
  if (diffDays === 0) return "due today";
  if (diffDays === 1) return "due tomorrow";
  return `due in ${diffDays} days`;
}

const Wrapper = styled.div`
  margin: 0 0 var(--space-lg) 0;
  padding: var(--space-md);
  background: var(--color-bg-subtle, var(--color-bg));
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
`;

const Label = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: var(--space-xs);
`;

const TaskList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const TaskItem = styled.li`
  font-size: var(--font-size-md);
  color: var(--color-text);
`;

export function TasksDueBlock() {
  const { user } = useAuth();
  const upkeep = useUpkeepBackend();
  const userBackend = useUserBackend();
  const [slugs, setSlugs] = useState<Record<string, string> | null>(null);
  // Per-list tasks keyed by listId; merged on read. Keying by listId means a
  // single list's update only swaps its slot, leaving siblings untouched.
  const [tasksByList, setTasksByList] = useState<Map<string, BackendTask[]>>(new Map());

  // Subscribe to the user's household slug map.
  useEffect(() => {
    if (!user?.uid) return;
    const unsub = userBackend.subscribeSlugs(user.uid, "household", (next) => {
      setSlugs(next);
    });
    return () => {
      unsub();
    };
  }, [user?.uid, userBackend]);

  // Dedup + sort for a stable subscription set.
  const listIds = useMemo<string[]>(() => {
    if (!slugs) return [];
    return Array.from(new Set(Object.values(slugs))).sort();
  }, [slugs]);
  // Joined key so the effect's deps array is a primitive that only changes
  // when the actual set of list IDs does.
  const listIdsKey = listIds.join(",");

  // Subscribe to every list's tasks. Resets when the set of lists changes.
  useEffect(() => {
    if (!user?.uid || listIds.length === 0) {
      setTasksByList(new Map());
      return;
    }
    setTasksByList(new Map()); // clear stale slots while next subscriptions warm up
    const unsubs = listIds.map((listId) =>
      upkeep.subscribeToList(listId, user.uid, {
        onList: () => {},
        onTasks: (next) => {
          setTasksByList((prev) => {
            const out = new Map(prev);
            out.set(listId, next);
            return out;
          });
        },
        onCompletions: () => {},
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
    // listIdsKey is the stable-deps proxy for the listIds array contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, listIdsKey, upkeep]);

  // One flattened union of every list's tasks; the buckets below filter/sort
  // over the leaf-filtered slice of it (was hand-rolled identically in each
  // memo). `allTasks` is the COMPLETE per-list set — onTasks is filtered only
  // by list, never by completed/cleared — so the parent-id set below is
  // accurate even when a container's children are all done.
  const allTasks = useMemo(
    () => [...tasksByList.values()].flat(),
    [tasksByList],
  );

  // Ids that some other task points at as its parent. parentId is "" for roots
  // (filtered out by Boolean).
  const parentIds = useMemo(
    () => new Set(allTasks.map((t) => t.parentId).filter(Boolean)),
    [allTasks],
  );

  // Only LEAF tasks surface here — a task with ANY child is a GROUP/container,
  // never an actionable todo. This mirrors the server notification crons'
  // `fetchParentIds` leaf rule (services/api/.../notifications/recipients.ts):
  // both deadlines.ts and upkeep.ts subtract that same parent-id set from their
  // due list, so the morning block and the notifications stay in lockstep.
  // Leaf-ness is STRUCTURAL — a container is a group even if its children are
  // all completed/cleared.
  const leafTasks = useMemo(
    () => allTasks.filter((t) => !parentIds.has(t.id)),
    [allTasks, parentIds],
  );

  const todayTasks = useMemo(() => {
    const now = new Date();
    return leafTasks
      .filter((t) => t.taskType === "recurring")
      .filter((t) => urgencyOf(t, now).kind === "dueToday")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [leafTasks]);

  // "Asap" one-shots: the union of OVERDUE dated todos (past their date) and
  // SOMEDAY undated todos (no prompt, would otherwise rot). These were one
  // conflated "asap" state; now they're distinct UrgencyState kinds. Overdue
  // sort first (most overdue on top); someday follow (no date to sort by).
  const asapTasks = useMemo(() => {
    const now = new Date();
    return leafTasks
      .filter((t) => isActionableOneShot(t, now))
      .map((t) => ({ t, u: urgencyOf(t, now) }))
      .filter(({ u }) => u.kind === "overdue" || u.kind === "someday")
      .sort((a, b) => {
        // overdue (with a date) before someday; among overdue, most-overdue first.
        const aDays = a.u.kind === "overdue" ? a.u.days : -Infinity;
        const bDays = b.u.kind === "overdue" ? b.u.days : -Infinity;
        return bDays - aDays;
      })
      .map(({ t }) => t);
  }, [leafTasks]);

  // One-shot todos due within 3 days, INCLUDING due-today. Routed through the
  // canonical `urgencyOf` projection for model consistency with the buckets
  // above. The ≤3-day window (rather than the `dueSoon` kind's full 1..7) is a
  // deliberate product choice — the dashboard keeps this block short. Overdue +
  // someday are handled by the Asap group above (so they aren't double-listed).
  // Sorted by deadline ascending so the most urgent is on top.
  const dueSoonTasks = useMemo(() => {
    const now = new Date();
    return leafTasks
      .filter((t) => isActionableOneShot(t, now))
      .filter((t) => {
        const u = urgencyOf(t, now);
        return u.kind === "dueToday" || (u.kind === "dueSoon" && u.days <= 3);
      })
      .sort((a, b) => (taskDeadline(a)?.getTime() ?? 0) - (taskDeadline(b)?.getTime() ?? 0));
  }, [leafTasks]);

  // Empty / loading / no-lists: render nothing.
  // Wait for every list's first onTasks callback before deciding "empty" so
  // we don't flash a partial union.
  if (
    !slugs ||
    listIds.length === 0 ||
    tasksByList.size < listIds.length ||
    (todayTasks.length === 0 && asapTasks.length === 0 && dueSoonTasks.length === 0)
  ) {
    return null;
  }

  return (
    <Wrapper aria-label="Today's upkeep">
      {asapTasks.length > 0 && (
        <>
          <Label>Asap</Label>
          <TaskList>
            {asapTasks.map((t) => {
              const deadline = taskDeadline(t);
              return (
                <TaskItem key={t.id}>
                  {t.name}
                  {deadline ? ` — ${formatDeadline(deadline)}` : ""}
                </TaskItem>
              );
            })}
          </TaskList>
        </>
      )}
      {todayTasks.length > 0 && (
        <>
          <Label style={{ marginTop: asapTasks.length > 0 ? "var(--space-md)" : undefined }}>
            Today&apos;s upkeep
          </Label>
          <TaskList>
            {todayTasks.map((t) => (
              <TaskItem key={t.id}>{t.name}</TaskItem>
            ))}
          </TaskList>
        </>
      )}
      {dueSoonTasks.length > 0 && (
        <>
          <Label
            style={{
              marginTop:
                asapTasks.length > 0 || todayTasks.length > 0 ? "var(--space-md)" : undefined,
            }}
          >
            Due soon
          </Label>
          <TaskList>
            {dueSoonTasks.map((t) => {
              const deadline = taskDeadline(t);
              return (
                <TaskItem key={t.id}>
                  {t.name} — {deadline ? formatDeadline(deadline) : ""}
                </TaskItem>
              );
            })}
          </TaskList>
        </>
      )}
    </Wrapper>
  );
}
