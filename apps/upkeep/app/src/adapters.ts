/**
 * Adapters between @homelab/backend types and the upkeep app's local types.
 *
 * The backend uses simplified types (Task, TaskList, TaskCompletion).
 * The app uses richer types with Date objects and structured Frequency.
 */
import type {
  Task as BackendTask,
  TaskList as BackendTaskList,
  TaskCompletion as BackendTaskCompletion,
} from "@homelab/backend";
import type { Task, TaskList, Completion } from "./types";

/** Convert a backend Task to the app's local Task type. */
export function taskFromBackend(t: BackendTask): Task {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    roomId: t.roomId,
    frequency: t.frequency,
    lastCompleted: t.lastCompleted,
    snoozedUntil: t.snoozedUntil,
    notifyUsers: t.notifyUsers,
    createdBy: t.createdBy,
    createdAt: new Date(t.created),
    updatedAt: new Date(t.updated),
  };
}

/** Convert a backend TaskList to the app's local TaskList type. */
export function listFromBackend(l: BackendTaskList): TaskList {
  return {
    id: l.id,
    name: l.name,
    owners: l.owners,
    rooms: l.rooms,
    created: new Date(l.created),
    updated: new Date(l.updated),
  };
}

/** Convert a backend TaskCompletion to the app's local Completion type. */
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
