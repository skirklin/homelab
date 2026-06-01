/**
 * Read-only "Today's upkeep" header rendered above the first prompt in the
 * morning session wizard. Glance-able context, not interactive — no checkboxes,
 * no complete/snooze affordances. Empty state renders nothing (no flicker, no
 * "Nothing due" message).
 *
 * Aggregates today's tasks across ALL household lists in the user's slug map.
 * The morning surface is a "what's due today" union — if you have multiple
 * lists they're all here. Today there's typically just one list (`home`), but
 * the union is the right shape for aggregation.
 */
import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { useAuth, useUpkeepBackend, useUserBackend } from "@kirkl/shared";
import {
  daysUntilDue,
  getUrgencyLevel,
  isTaskSnoozed,
  type Task as BackendTask,
} from "@homelab/backend";

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

export function MorningUpkeepHeader() {
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

  const todayTasks = useMemo(() => {
    const all: BackendTask[] = [];
    for (const tasks of tasksByList.values()) all.push(...tasks);
    return all
      .filter((t) => t.taskType === "recurring")
      .filter((t) => !isTaskSnoozed(t))
      .filter((t) => getUrgencyLevel(t) === "today")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tasksByList]);

  // One-shot todos with a deadline within 3 days (or overdue). Sorted by
  // deadline ascending so the most urgent is on top.
  const dueSoonTasks = useMemo(() => {
    const all: BackendTask[] = [];
    for (const tasks of tasksByList.values()) all.push(...tasks);
    return all
      .filter((t) => t.taskType === "one_shot")
      .filter((t) => !isTaskSnoozed(t))
      .filter((t) => !t.completed && !t.cleared)
      .filter((t) => {
        const d = daysUntilDue(t);
        return d !== null && d <= 3;
      })
      .sort((a, b) => (a.deadline?.getTime() ?? 0) - (b.deadline?.getTime() ?? 0));
  }, [tasksByList]);

  // Empty / loading / no-lists: render nothing.
  // Wait for every list's first onTasks callback before deciding "empty" so
  // we don't flash a partial union.
  if (
    !slugs ||
    listIds.length === 0 ||
    tasksByList.size < listIds.length ||
    (todayTasks.length === 0 && dueSoonTasks.length === 0)
  ) {
    return null;
  }

  return (
    <Wrapper aria-label="Today's upkeep">
      {todayTasks.length > 0 && (
        <>
          <Label>Today&apos;s upkeep</Label>
          <TaskList>
            {todayTasks.map((t) => (
              <TaskItem key={t.id}>{t.name}</TaskItem>
            ))}
          </TaskList>
        </>
      )}
      {dueSoonTasks.length > 0 && (
        <>
          <Label style={{ marginTop: todayTasks.length > 0 ? "var(--space-md)" : undefined }}>
            Due soon
          </Label>
          <TaskList>
            {dueSoonTasks.map((t) => (
              <TaskItem key={t.id}>
                {t.name} — {t.deadline ? formatDeadline(t.deadline) : ""}
              </TaskItem>
            ))}
          </TaskList>
        </>
      )}
    </Wrapper>
  );
}
