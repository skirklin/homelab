/**
 * Read-only "Today's upkeep" header rendered above the first prompt in the
 * morning session wizard. Glance-able context, not interactive — no checkboxes,
 * no complete/snooze affordances. Empty state renders nothing (no flicker, no
 * "Nothing due" message).
 *
 * v1 picks the first task list alphabetically by slug. Users with multiple
 * household lists only see one — see report for follow-up.
 */
import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { useAuth, useUpkeepBackend, useUserBackend } from "@kirkl/shared";
import {
  getUrgencyLevel,
  isTaskSnoozed,
  type Task as BackendTask,
} from "@homelab/backend";

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

function pickPrimaryListId(slugs: Record<string, string>): string | null {
  const entries = Object.entries(slugs);
  if (entries.length === 0) return null;
  // Deterministic: first slug alphabetically. v1 just picks one.
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries[0][1];
}

export function MorningUpkeepHeader() {
  const { user } = useAuth();
  const upkeep = useUpkeepBackend();
  const userBackend = useUserBackend();
  const [slugs, setSlugs] = useState<Record<string, string> | null>(null);
  const [tasks, setTasks] = useState<BackendTask[] | null>(null);

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

  const listId = useMemo(() => (slugs ? pickPrimaryListId(slugs) : null), [slugs]);

  // Subscribe to the picked list's tasks. Resets when listId changes.
  useEffect(() => {
    if (!user?.uid || !listId) {
      setTasks(null);
      return;
    }
    setTasks(null); // clear stale data while next list loads
    const unsub = upkeep.subscribeToList(listId, user.uid, {
      onList: () => {},
      onTasks: (next) => setTasks(next),
      onCompletions: () => {},
    });
    return () => {
      unsub();
    };
  }, [user?.uid, listId, upkeep]);

  const todayTasks = useMemo(() => {
    if (!tasks) return [];
    return tasks
      .filter((t) => t.taskType === "recurring")
      .filter((t) => !isTaskSnoozed(t))
      .filter((t) => getUrgencyLevel(t) === "today");
  }, [tasks]);

  // Empty / loading / no-lists: render nothing.
  if (!slugs || !listId || !tasks || todayTasks.length === 0) {
    return null;
  }

  return (
    <Wrapper aria-label="Today's upkeep">
      <Label>Today&apos;s upkeep</Label>
      <TaskList>
        {todayTasks.map((t) => (
          <TaskItem key={t.id}>{t.name}</TaskItem>
        ))}
      </TaskList>
    </Wrapper>
  );
}
