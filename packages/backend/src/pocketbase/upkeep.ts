/**
 * PocketBase implementation of UpkeepBackend.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { TaskList, Task, RoomDef, TaskCompletion } from "../types/upkeep";
import type { Unsubscribe } from "../types/common";

function listFromRecord(r: RecordModel): TaskList {
  return {
    id: r.id,
    name: r.name || "",
    owners: Array.isArray(r.owners) ? r.owners : [],
    rooms: Array.isArray(r.room_defs) ? r.room_defs : [],
  };
}

function taskFromRecord(r: RecordModel): Task {
  return {
    id: r.id,
    list: r.list,
    name: r.name || "",
    description: r.description || "",
    roomId: r.room_id || "",
    frequency: r.frequency || 0,
    lastCompleted: r.last_completed ? new Date(r.last_completed) : null,
    snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until) : null,
    notifyUsers: Array.isArray(r.notify_users) ? r.notify_users : [],
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
      room_defs: [],
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

  async updateRooms(listId: string, rooms: RoomDef[]): Promise<void> {
    await this.pb().collection("task_lists").update(listId, { room_defs: rooms });
  }

  async addTask(listId: string, task: Omit<Task, "id" | "list">): Promise<string> {
    const record = await this.pb().collection("tasks").create({
      list: listId,
      name: task.name,
      description: task.description,
      room_id: task.roomId,
      frequency: task.frequency,
      last_completed: task.lastCompleted?.toISOString() || null,
      snoozed_until: null,
      notify_users: task.notifyUsers || [],
    });
    return record.id;
  }

  async updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "list">>): Promise<void> {
    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.roomId !== undefined) data.room_id = updates.roomId;
    if (updates.frequency !== undefined) data.frequency = updates.frequency;
    if (updates.lastCompleted !== undefined) data.last_completed = updates.lastCompleted?.toISOString() || null;
    if (updates.snoozedUntil !== undefined) data.snoozed_until = updates.snoozedUntil?.toISOString() || null;
    if (updates.notifyUsers !== undefined) data.notify_users = updates.notifyUsers;
    await this.pb().collection("tasks").update(taskId, data);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.pb().collection("tasks").delete(taskId);
  }

  async snoozeTask(taskId: string, until: Date): Promise<void> {
    await this.pb().collection("tasks").update(taskId, { snoozed_until: until.toISOString() });
  }

  async unsnoozeTask(taskId: string): Promise<void> {
    await this.pb().collection("tasks").update(taskId, { snoozed_until: null });
  }

  async completeTask(taskId: string, userId: string, options?: { notes?: string; completedAt?: Date }): Promise<void> {
    const timestamp = (options?.completedAt ?? new Date()).toISOString();
    await this.pb().collection("tasks").update(taskId, { last_completed: timestamp });
    await this.pb().collection("task_events").create({
      list: (await this.pb().collection("tasks").getOne(taskId)).list,
      subject_id: taskId,
      timestamp,
      created_by: userId,
      data: options?.notes ? { notes: options.notes } : {},
    });
  }

  async toggleTaskNotification(taskId: string, userId: string, enable: boolean): Promise<void> {
    if (enable) {
      await this.pb().collection("tasks").update(taskId, { "notify_users+": userId });
    } else {
      await this.pb().collection("tasks").update(taskId, { "notify_users-": userId });
    }
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
  }

  async deleteCompletion(eventId: string): Promise<void> {
    await this.pb().collection("task_events").delete(eventId);
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
      filter: `list = "${listId}"`,
      belongsTo: (r) => r.list === listId,
      onInitial: (records) => { for (const r of records) tasksMap.set(r.id, taskFromRecord(r)); emitTasks(); },
      onChange: (action, r) => {
        if (action === "delete") tasksMap.delete(r.id); else tasksMap.set(r.id, taskFromRecord(r));
        emitTasks();
      },
    });

    // Completions — reload on any change
    this.initSubscribeToReload("task_events", isCancelled, unsubs, {
      filter: `list = "${listId}"`,
      sort: "-timestamp",
      perPage: 100,
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
