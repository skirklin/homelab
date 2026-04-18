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
  return {
    id: t.id,
    parentId: t.parentId,
    path: t.path,
    position: t.position,
    name: t.name,
    description: t.description,
    taskType: t.taskType,
    frequency: t.frequency,
    lastCompleted: t.lastCompleted,
    completed: t.completed,
    snoozedUntil: t.snoozedUntil,
    notifyUsers: t.notifyUsers,
    createdBy: t.createdBy,
    tags: t.tags,
    collapsed: t.collapsed,
    createdAt: new Date(t.created),
    updatedAt: new Date(t.updated),
  };
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
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    data: c.data,
  };
}
