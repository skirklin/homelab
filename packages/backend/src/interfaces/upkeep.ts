/**
 * Unified task system backend interface.
 *
 * Covers: task lists, tree-structured tasks, completions, notification preferences.
 */
import type { Unsubscribe } from "../types/common";
import type { TaskList, Task, TaskCompletion } from "../types/upkeep";

export interface UpkeepBackend {
  // --- List CRUD ---

  createList(name: string, userId: string): Promise<string>;
  renameList(listId: string, name: string): Promise<void>;
  deleteList(listId: string): Promise<void>;
  getList(listId: string): Promise<TaskList | null>;

  // --- Task CRUD (tree-aware) ---

  addTask(
    listId: string,
    task: Omit<Task, "id" | "list" | "path" | "created" | "updated" | "createdBy">,
  ): Promise<string>;
  updateTask(
    taskId: string,
    updates: Partial<Omit<Task, "id" | "list" | "path" | "created" | "updated" | "createdBy">>,
  ): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  moveTask(taskId: string, newParentId: string | null, position: number): Promise<void>;

  // --- Task actions ---

  snoozeTask(taskId: string, until: Date): Promise<void>;
  unsnoozeTask(taskId: string): Promise<void>;
  /** Mark a recurring task as completed (creates a task_event, updates last_completed). */
  completeTask(taskId: string, userId: string, options?: { notes?: string; completedAt?: Date }): Promise<void>;
  /** Toggle a one-shot task's completed boolean. */
  toggleComplete(taskId: string): Promise<void>;
  toggleTaskNotification(taskId: string, userId: string, enable: boolean): Promise<void>;
  /** Toggle the collapsed state (expand/collapse children in outliner). */
  toggleCollapsed(taskId: string): Promise<void>;

  // --- Tree queries ---

  getSubtree(rootTaskId: string): Promise<Task[]>;
  getTasksByTag(listId: string, tag: string): Promise<Task[]>;

  // --- Templates ---

  /** Deep-copy a template subtree, applying the given tags to all copies. Returns new root ID. */
  instantiateTemplate(templateRootId: string, tags: string[]): Promise<string>;

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
