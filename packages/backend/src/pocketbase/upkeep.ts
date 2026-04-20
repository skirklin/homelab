/**
 * PocketBase implementation of UpkeepBackend (unified task system).
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { TaskList, Task, TaskCompletion } from "../types/upkeep";
import type { Unsubscribe } from "../types/common";

// --- Pagination limits ---

const COMPLETIONS_PAGE_SIZE = 100;

function listFromRecord(r: RecordModel): TaskList {
  return {
    id: r.id,
    name: r.name || "",
    owners: Array.isArray(r.owners) ? r.owners : [],
    created: r.created,
    updated: r.updated,
  };
}

function taskFromRecord(r: RecordModel): Task {
  return {
    id: r.id,
    list: r.list,
    parentId: r.parent_id || "",
    path: r.path || r.id,
    position: r.position ?? 0,
    name: r.name || "",
    description: r.description || "",
    taskType: r.task_type || "recurring",
    frequency: r.frequency || 0,
    lastCompleted: r.last_completed ? new Date(r.last_completed) : null,
    completed: !!r.completed,
    snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until) : null,
    notifyUsers: Array.isArray(r.notify_users) ? r.notify_users : [],
    createdBy: r.created_by || "",
    tags: Array.isArray(r.tags) ? r.tags : [],
    collapsed: !!r.collapsed,
    created: r.created,
    updated: r.updated,
  };
}

function completionFromRecord(r: RecordModel): TaskCompletion {
  return {
    id: r.id,
    subjectId: r.subject_id || "",
    timestamp: new Date(r.timestamp),
    createdAt: new Date(r.created),
    createdBy: r.created_by || "",
    data: r.data || {},
  };
}

export class PocketBaseUpkeepBackend implements UpkeepBackend {
  constructor(private pb: () => PocketBase) {}

  async createList(name: string, userId: string): Promise<string> {
    const list = await this.pb().collection("task_lists").create({
      name,
      owners: [userId],
    }, { $autoCancel: false });
    return list.id;
  }

  async renameList(listId: string, name: string): Promise<void> {
    await this.pb().collection("task_lists").update(listId, { name });
  }

  async deleteList(listId: string): Promise<void> {
    await this.pb().collection("task_lists").delete(listId);
  }

  async getList(listId: string): Promise<TaskList | null> {
    try {
      return listFromRecord(await this.pb().collection("task_lists").getOne(listId));
    } catch {
      return null;
    }
  }

  async addTask(
    listId: string,
    task: Omit<Task, "id" | "list" | "path" | "created" | "updated" | "createdBy">,
  ): Promise<string> {
    // Create the record first to get an ID, then set the path
    const record = await this.pb().collection("tasks").create({
      list: listId,
      parent_id: task.parentId || "",
      path: "", // placeholder, set below
      position: task.position ?? 0,
      name: task.name,
      description: task.description || "",
      task_type: task.taskType || "recurring",
      frequency: task.frequency,
      last_completed: task.lastCompleted?.toISOString() || null,
      completed: task.completed || false,
      snoozed_until: null,
      notify_users: task.notifyUsers || [],
      tags: task.tags || [],
      collapsed: false,
    });

    // Build path: parent's path + "/" + own ID, or just own ID for root
    let path = record.id;
    if (task.parentId) {
      const parent = await this.pb().collection("tasks").getOne(task.parentId);
      path = `${parent.path}/${record.id}`;
    }
    await this.pb().collection("tasks").update(record.id, { path });

    return record.id;
  }

  async updateTask(
    taskId: string,
    updates: Partial<Omit<Task, "id" | "list" | "path" | "created" | "updated" | "createdBy">>,
  ): Promise<void> {
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.taskType !== undefined) data.task_type = updates.taskType;
    if (updates.frequency !== undefined) data.frequency = updates.frequency;
    if (updates.lastCompleted !== undefined) data.last_completed = updates.lastCompleted?.toISOString() || null;
    if (updates.completed !== undefined) data.completed = updates.completed;
    if (updates.snoozedUntil !== undefined) data.snoozed_until = updates.snoozedUntil?.toISOString() || null;
    if (updates.notifyUsers !== undefined) data.notify_users = updates.notifyUsers;
    if (updates.tags !== undefined) data.tags = updates.tags;
    if (updates.collapsed !== undefined) data.collapsed = updates.collapsed;
    if (updates.position !== undefined) data.position = updates.position;
    if (updates.parentId !== undefined) data.parent_id = updates.parentId;
    await this.pb().collection("tasks").update(taskId, data);
  }

  async deleteTask(taskId: string): Promise<void> {
    // Delete the task and all descendants (by path prefix)
    const task = await this.pb().collection("tasks").getOne(taskId);
    const descendants = await this.pb().collection("tasks").getFullList({
      filter: this.pb().filter("path ~ {:prefix}", { prefix: `${task.path}/%` }),
      $autoCancel: false,
    });
    // Delete children first (deepest first to avoid cascade issues)
    descendants.sort((a, b) => b.path.length - a.path.length);
    for (const d of descendants) {
      await this.pb().collection("tasks").delete(d.id);
    }
    await this.pb().collection("tasks").delete(taskId);
  }

  async moveTask(taskId: string, newParentId: string | null, position: number): Promise<void> {
    const task = await this.pb().collection("tasks").getOne(taskId);
    const oldPath = task.path;

    // Compute new path
    let newPath: string;
    if (newParentId) {
      const parent = await this.pb().collection("tasks").getOne(newParentId);
      newPath = `${parent.path}/${taskId}`;
    } else {
      newPath = taskId;
    }

    // Update the task itself
    await this.pb().collection("tasks").update(taskId, {
      parent_id: newParentId || "",
      path: newPath,
      position,
    });

    // Update all descendants' paths (swap prefix)
    const descendants = await this.pb().collection("tasks").getFullList({
      filter: this.pb().filter("path ~ {:prefix}", { prefix: `${oldPath}/%` }),
      $autoCancel: false,
    });
    for (const d of descendants) {
      const updatedPath = newPath + d.path.slice(oldPath.length);
      await this.pb().collection("tasks").update(d.id, { path: updatedPath });
    }
  }

  async snoozeTask(taskId: string, until: Date): Promise<void> {
    await this.pb().collection("tasks").update(taskId, { snoozed_until: until.toISOString() });
  }

  async unsnoozeTask(taskId: string): Promise<void> {
    await this.pb().collection("tasks").update(taskId, { snoozed_until: null });
  }

  /**
   * Recompute `last_completed` on a task from the max timestamp across its
   * task_events. Keeps the denormalized field honest after any event change
   * (create, update, delete). If no events remain, clears the field.
   */
  private async recomputeLastCompleted(taskId: string): Promise<void> {
    const events = await this.pb().collection("task_events").getList(1, 1, {
      filter: `subject_id="${taskId}"`,
      sort: "-timestamp",
    });
    const latest = events.items[0]?.timestamp ?? null;
    await this.pb().collection("tasks").update(taskId, { last_completed: latest });
  }

  async completeTask(taskId: string, userId: string, options?: { notes?: string; completedAt?: Date }): Promise<void> {
    const timestamp = (options?.completedAt ?? new Date()).toISOString();
    const task = await this.pb().collection("tasks").getOne(taskId);
    await this.pb().collection("task_events").create({
      list: task.list,
      subject_id: taskId,
      timestamp,
      created_by: userId,
      data: options?.notes ? { notes: options.notes } : {},
    });
    await this.recomputeLastCompleted(taskId);
  }

  async toggleComplete(taskId: string): Promise<void> {
    const task = await this.pb().collection("tasks").getOne(taskId);
    await this.pb().collection("tasks").update(taskId, { completed: !task.completed });
  }

  async toggleTaskNotification(taskId: string, userId: string, enable: boolean): Promise<void> {
    if (enable) {
      await this.pb().collection("tasks").update(taskId, { "notify_users+": userId });
    } else {
      await this.pb().collection("tasks").update(taskId, { "notify_users-": userId });
    }
  }

  async toggleCollapsed(taskId: string): Promise<void> {
    const task = await this.pb().collection("tasks").getOne(taskId);
    await this.pb().collection("tasks").update(taskId, { collapsed: !task.collapsed });
  }

  async getSubtree(rootTaskId: string): Promise<Task[]> {
    const root = await this.pb().collection("tasks").getOne(rootTaskId);
    const descendants = await this.pb().collection("tasks").getFullList({
      filter: this.pb().filter("path ~ {:prefix}", { prefix: `${root.path}/%` }),
      $autoCancel: false,
    });
    return [root, ...descendants].map(taskFromRecord);
  }

  async getTasksByTag(listId: string, tag: string): Promise<Task[]> {
    const records = await this.pb().collection("tasks").getFullList({
      filter: this.pb().filter("list = {:listId} && tags ~ {:tag}", { listId, tag }),
      $autoCancel: false,
    });
    return records.map(taskFromRecord);
  }

  async instantiateTemplate(templateRootId: string, tags: string[]): Promise<string> {
    // Get the full template subtree
    const subtree = await this.getSubtree(templateRootId);
    // Sort by path length (parents first)
    subtree.sort((a, b) => a.path.length - b.path.length);

    // Map old IDs to new IDs
    const idMap = new Map<string, string>();

    for (const task of subtree) {
      const newParentId = task.parentId ? (idMap.get(task.parentId) || "") : "";
      const newId = await this.addTask(task.list, {
        parentId: newParentId,
        position: task.position,
        name: task.name,
        description: task.description,
        taskType: task.taskType,
        frequency: task.frequency,
        lastCompleted: null,
        completed: false,
        snoozedUntil: null,
        notifyUsers: [],
        tags: tags.filter((t) => !t.startsWith("template:")), // apply target tags, strip template tags
        collapsed: task.collapsed,
      });
      idMap.set(task.id, newId);
    }

    return idMap.get(subtree[0].id)!;
  }

  async updateCompletion(eventId: string, updates: { notes?: string; timestamp?: Date }): Promise<void> {
    const record = await this.pb().collection("task_events").getOne(eventId);
    const data: Record<string, unknown> = {};
    if (updates.timestamp) data.timestamp = updates.timestamp.toISOString();
    if (updates.notes !== undefined) {
      const existing = record.data || {};
      data.data = { ...existing, notes: updates.notes.trim() || undefined };
    }
    await this.pb().collection("task_events").update(eventId, data);
    // Timestamp edit may change which event is "latest" — keep last_completed honest.
    if (updates.timestamp !== undefined) {
      await this.recomputeLastCompleted(record.subject_id);
    }
  }

  async deleteCompletion(eventId: string): Promise<void> {
    const record = await this.pb().collection("task_events").getOne(eventId);
    await this.pb().collection("task_events").delete(eventId);
    await this.recomputeLastCompleted(record.subject_id);
  }

  subscribeToList(
    listId: string,
    _userId: string,
    handlers: {
      onList: (list: TaskList) => void;
      onTasks: (tasks: Task[]) => void;
      onCompletions: (completions: TaskCompletion[]) => void;
      onDeleted?: () => void;
    },
  ): Unsubscribe {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const unsubs: Array<() => void> = [];
    const tasksMap = new Map<string, Task>();

    const emitTasks = () => {
      if (!cancelled) handlers.onTasks(Array.from(tasksMap.values()));
    };

    // List metadata
    this.initSubscribeToRecord("task_lists", listId, isCancelled, unsubs, {
      onData: (r) => handlers.onList(listFromRecord(r)),
      onDelete: () => handlers.onDeleted?.(),
    });

    // Tasks
    this.initSubscribeToCollection("tasks", isCancelled, unsubs, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      belongsTo: (r) => r.list === listId,
      onInitial: (records) => { for (const r of records) tasksMap.set(r.id, taskFromRecord(r)); emitTasks(); },
      onChange: (action, r) => {
        if (action === "delete") tasksMap.delete(r.id); else tasksMap.set(r.id, taskFromRecord(r));
        emitTasks();
      },
    });

    // Completions — reload on any change
    this.initSubscribeToReload("task_events", isCancelled, unsubs, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      sort: "-timestamp",
      perPage: COMPLETIONS_PAGE_SIZE,
      belongsTo: (r) => r.list === listId,
      onData: (records) => handlers.onCompletions(records.map(completionFromRecord)),
    });

    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }

  // --- Internal subscription helpers ---

  private initSubscribeToRecord(
    col: string, id: string, cancelled: () => boolean, unsubs: Array<() => void>,
    cb: { onData: (r: RecordModel) => void; onDelete?: () => void },
  ) {
    this.pb().collection(col).getOne(id, { $autoCancel: false }).then((r) => {
      if (!cancelled()) cb.onData(r);
    }).catch(() => {});
    this.pb().collection(col).subscribe(id, (e) => {
      if (cancelled()) return;
      if (e.action === "delete") cb.onDelete?.(); else cb.onData(e.record);
    }).then((unsub) => unsubs.push(unsub));
  }

  private initSubscribeToCollection(
    col: string, cancelled: () => boolean, unsubs: Array<() => void>,
    opts: { filter: string; belongsTo: (r: RecordModel) => boolean; onInitial: (rs: RecordModel[]) => void; onChange: (a: string, r: RecordModel) => void },
  ) {
    this.pb().collection(col).getFullList({ filter: opts.filter, $autoCancel: false }).then((rs) => {
      if (!cancelled()) opts.onInitial(rs);
    }).catch(() => { if (!cancelled()) opts.onInitial([]); });
    this.pb().collection(col).subscribe("*", (e) => {
      if (cancelled() || !opts.belongsTo(e.record)) return;
      opts.onChange(e.action, e.record);
    }).then((unsub) => unsubs.push(unsub));
  }

  private initSubscribeToReload(
    col: string, cancelled: () => boolean, unsubs: Array<() => void>,
    opts: { filter: string; sort: string; perPage: number; belongsTo: (r: RecordModel) => boolean; onData: (rs: RecordModel[]) => void },
  ) {
    const reload = () => {
      this.pb().collection(col).getList(1, opts.perPage, { filter: opts.filter, sort: opts.sort, $autoCancel: false }).then((r) => {
        if (!cancelled()) opts.onData(r.items);
      }).catch(() => { if (!cancelled()) opts.onData([]); });
    };
    reload();
    this.pb().collection(col).subscribe("*", (e) => {
      if (cancelled() || !opts.belongsTo(e.record)) return;
      reload();
    }).then((unsub) => unsubs.push(unsub));
  }
}
