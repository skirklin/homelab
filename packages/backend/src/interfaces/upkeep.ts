/**
 * Unified task system backend interface.
 *
 * Covers: task lists, tree-structured tasks, completions, notification preferences.
 */
import type { Unsubscribe } from "../types/common";
import type { TaskList, Task, TaskCompletion, TaskUpdate } from "../types/upkeep";

/**
 * Shape passed to `addTask`. A full task variant minus the server-stamped
 * read fields. The conditional makes `Omit` DISTRIBUTE over the `Task` union
 * (a bare `Omit<A | B, K>` collapses to the intersection of keys and loses the
 * discriminant), so a recurring create can't carry a `schedule` and a one-shot
 * create can't carry a `frequency`.
 */
export type NewTask = Task extends infer T
  ? T extends Task
    ? Omit<T, "id" | "list" | "path" | "created" | "updated" | "createdBy">
    : never
  : never;

export interface UpkeepBackend {
  // --- List CRUD ---

  createList(name: string, userId: string): Promise<string>;
  renameList(listId: string, name: string): Promise<void>;
  deleteList(listId: string): Promise<void>;
  getList(listId: string): Promise<TaskList | null>;

  // --- Task CRUD (tree-aware) ---

  addTask(listId: string, task: NewTask): Promise<string>;
  updateTask(taskId: string, updates: Partial<TaskUpdate>): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  moveTask(taskId: string, newParentId: string | null, position: number): Promise<void>;

  // --- Task actions ---

  snoozeTask(taskId: string, until: Date): Promise<void>;
  unsnoozeTask(taskId: string): Promise<void>;
  /**
   * Add and/or remove tags atomically.
   * `remove` is applied first, then `add` (deduped against the survivors).
   * Reads the latest queue-aware tag list rather than relying on a caller-supplied
   * snapshot, so concurrent partial edits on the same client don't clobber each
   * other the way `updateTask({ tags: [...] })` does.
   */
  tagTask(taskId: string, opts: { add?: string[]; remove?: string[] }): Promise<void>;
  /** Mark a recurring task as completed (creates a task_event, updates last_completed). */
  completeTask(taskId: string, userId: string, options?: { notes?: string; completedAt?: Date }): Promise<void>;
  /** Toggle a one-shot task's completed boolean. */
  toggleComplete(taskId: string): Promise<void>;
  toggleTaskNotification(taskId: string, userId: string, enable: boolean): Promise<void>;
  /** Toggle the collapsed state (expand/collapse children in outliner). */
  toggleCollapsed(taskId: string): Promise<void>;
  /**
   * Soft-hide every completed, not-yet-cleared one_shot task in the list by
   * setting `cleared = true`. Recurring tasks are excluded (they self-reset
   * via last_completed). Returns the number of tasks actually flipped.
   */
  clearDoneTasks(listId: string): Promise<{ clearedCount: number }>;

  // --- Tree queries ---

  getSubtree(rootTaskId: string): Promise<Task[]>;
  getTasksByTag(listId: string, tag: string): Promise<Task[]>;

  // --- Completion history ---

  updateCompletion(eventId: string, updates: { notes?: string; timestamp?: Date }): Promise<void>;
  deleteCompletion(eventId: string): Promise<void>;

  // --- Subscriptions ---

  /**
   * Subscribe to all data for a task list.
   * Returns flat Task[] — frontend builds tree from parentId + position.
   */
  subscribeToList(
    listId: string,
    userId: string,
    handlers: {
      onList: (list: TaskList) => void;
      onTasks: (tasks: Task[]) => void;
      onCompletions: (completions: TaskCompletion[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe;
}
