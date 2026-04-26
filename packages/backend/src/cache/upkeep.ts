/**
 * Upkeep (tasks) backend cache decorator.
 */
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { TaskList, Task, TaskCompletion } from "../types/upkeep";
import type { Unsubscribe } from "../types/common";
import { cachedRead, cached, hydrateOne } from "./helpers";

export function withUpkeepCache(inner: UpkeepBackend): UpkeepBackend {
  return {
    // Reads
    getList: (id) => cachedRead<TaskList | null>(`upkeep:list:${id}`, () => inner.getList(id)),
    getSubtree: (rootId) => cachedRead<Task[]>(`upkeep:subtree:${rootId}`, () => inner.getSubtree(rootId)),
    getTasksByTag: (listId, tag) =>
      cachedRead<Task[]>(`upkeep:tasksByTag:${listId}:${tag}`, () => inner.getTasksByTag(listId, tag)),

    // Writes — pass through.
    createList: (n, u) => inner.createList(n, u),
    renameList: (id, n) => inner.renameList(id, n),
    deleteList: (id) => inner.deleteList(id),
    addTask: (listId, t) => inner.addTask(listId, t),
    updateTask: (id, u) => inner.updateTask(id, u),
    deleteTask: (id) => inner.deleteTask(id),
    moveTask: (id, parent, pos) => inner.moveTask(id, parent, pos),
    snoozeTask: (id, until) => inner.snoozeTask(id, until),
    unsnoozeTask: (id) => inner.unsnoozeTask(id),
    completeTask: (id, userId, opts) => inner.completeTask(id, userId, opts),
    toggleComplete: (id) => inner.toggleComplete(id),
    toggleTaskNotification: (id, userId, enable) => inner.toggleTaskNotification(id, userId, enable),
    toggleCollapsed: (id) => inner.toggleCollapsed(id),
    instantiateTemplate: (id, tags) => inner.instantiateTemplate(id, tags),
    updateCompletion: (id, u) => inner.updateCompletion(id, u),
    deleteCompletion: (id) => inner.deleteCompletion(id),

    subscribeToList(listId, userId, handlers): Unsubscribe {
      const listKey = `upkeep:list:${listId}`;
      const tasksKey = `upkeep:tasks:${listId}`;
      const completionsKey = `upkeep:completions:${listId}:${userId}`;

      const listH = hydrateOne<TaskList>(listKey, handlers.onList);
      const tasksH = hydrateOne<Task[]>(tasksKey, handlers.onTasks);
      const compH = hydrateOne<TaskCompletion[]>(completionsKey, handlers.onCompletions);

      return inner.subscribeToList(listId, userId, {
        onList: cached(listKey, (l) => {
          listH.live();
          handlers.onList(l);
        }),
        onTasks: cached(tasksKey, (t) => {
          tasksH.live();
          handlers.onTasks(t);
        }),
        onCompletions: cached(completionsKey, (c) => {
          compH.live();
          handlers.onCompletions(c);
        }),
        onDeleted: handlers.onDeleted,
      });
    },
  };
}
