/**
 * Upkeep (household tasks) backend interface.
 *
 * Covers: task lists, tasks, completions, notification preferences.
 */
import type { Unsubscribe } from "../types/common";
import type { TaskList, Task, RoomDef, TaskCompletion } from "../types/upkeep";

export interface UpkeepBackend {
  // --- List CRUD ---

  createList(name: string, userId: string): Promise<string>;
  renameList(listId: string, name: string): Promise<void>;
  deleteList(listId: string): Promise<void>;
  getList(listId: string): Promise<TaskList | null>;

  // --- Rooms ---

  updateRooms(listId: string, rooms: RoomDef[]): Promise<void>;

  // --- Task CRUD ---

  addTask(listId: string, task: Omit<Task, "id" | "list">): Promise<string>;
  updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "list">>): Promise<void>;
  deleteTask(taskId: string): Promise<void>;

  // --- Task actions ---

  snoozeTask(taskId: string, until: Date): Promise<void>;
  unsnoozeTask(taskId: string): Promise<void>;
  completeTask(taskId: string, userId: string, options?: { notes?: string; completedAt?: Date }): Promise<void>;
  toggleTaskNotification(taskId: string, userId: string, enable: boolean): Promise<void>;

  // --- Completion history ---

  updateCompletion(eventId: string, updates: { notes?: string; timestamp?: Date }): Promise<void>;
  deleteCompletion(eventId: string): Promise<void>;

  // --- Subscriptions ---

  /**
   * Subscribe to all data for a task list.
   * Callbacks receive full current state on initial load and after every change.
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
