/**
 * Adapters between @homelab/backend types and the upkeep app's local types.
 */
import type {
  Task as BackendTask,
  TaskList as BackendTaskList,
  TaskCompletion as BackendTaskCompletion,
} from "@homelab/backend";
import type { Task, TaskList, Completion } from "./types";

export function taskFromBackend(t: BackendTask): Task {
  const base = {
    id: t.id,
    parentId: t.parentId,
    path: t.path,
    position: t.position,
    name: t.name,
    description: t.description,
    snoozedUntil: t.snoozedUntil,
    assignees: t.assignees,
    createdBy: t.createdBy,
    tags: t.tags,
    collapsed: t.collapsed,
    createdAt: new Date(t.created),
    updatedAt: new Date(t.updated),
  };
  if (t.taskType === "one_shot") {
    return { ...base, taskType: "one_shot", schedule: t.schedule, completed: t.completed, cleared: t.cleared };
  }
  return { ...base, taskType: "recurring", frequency: t.frequency, lastCompleted: t.lastCompleted };
}

export function listFromBackend(l: BackendTaskList): TaskList {
  return {
    id: l.id,
    name: l.name,
    owners: l.owners,
    created: new Date(l.created),
    updated: new Date(l.updated),
  };
}

export function completionFromBackend(c: BackendTaskCompletion): Completion {
  return {
    id: c.id,
    subjectId: c.subjectId,
    timestamp: c.timestamp,
    endTime: c.endTime,
    entries: c.entries,
    labels: c.labels,
    createdBy: c.createdBy,
    created: c.created,
    updated: c.updated,
  };
}
