/**
 * PocketBase implementation of UpkeepBackend (unified task system).
 *
 * Writes route through the optimistic wrapper. addTask collapses the
 * old 3-RTT (create → fetch parent → update path) flow into a single
 * create with a client-computed path — the parent is read from the
 * wpb's in-memory queue, which the active subscription has already
 * populated. Falls back to a 1-extra-fetch path if the parent isn't
 * cached (e.g. deep link), still beating the original 3 RTTs.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { TaskList, Task, TaskCompletion } from "../types/upkeep";
import type { Unsubscribe } from "../types/common";
import { newId } from "../cache/ids";
import { wrapPocketBase, type WrappedPocketBase } from "../wrapped-pb";

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
  private wpb: WrappedPocketBase;

  constructor(private pb: () => PocketBase, wpb?: WrappedPocketBase) {
    this.wpb = wpb ?? wrapPocketBase(pb);
  }

  async createList(name: string, userId: string): Promise<string> {
    const id = newId();
    await this.wpb.collection("task_lists").create({
      id,
      name,
      owners: [userId],
    }, { $autoCancel: false });
    return id;
  }

  async renameList(listId: string, name: string): Promise<void> {
    await this.wpb.collection("task_lists").update(listId, { name });
  }

  async deleteList(listId: string): Promise<void> {
    await this.wpb.collection("task_lists").delete(listId);
  }

  async getList(listId: string): Promise<TaskList | null> {
    try {
      return listFromRecord(await this.pb().collection("task_lists").getOne(listId));
    } catch {
      return null;
    }
  }

  /**
   * Resolve the parent path locally if cached, else fetch it from the server.
   * Caching gets us the 1-RTT addTask; fallback covers deep-link / fresh-mount cases.
   */
  private async resolveParentPath(parentId: string): Promise<string | null> {
    const cached = this.wpb.collection("tasks").view<RecordModel>(parentId);
    if (cached && typeof cached.path === "string" && cached.path.length > 0) {
      return cached.path;
    }
    try {
      const parent = await this.pb().collection("tasks").getOne(parentId, { $autoCancel: false });
      return parent.path || parent.id;
    } catch {
      return null;
    }
  }

  async addTask(
    listId: string,
    task: Omit<Task, "id" | "list" | "path" | "created" | "updated" | "createdBy">,
  ): Promise<string> {
    const id = newId();
    const parentPath = task.parentId ? await this.resolveParentPath(task.parentId) : null;
    const path = parentPath ? `${parentPath}/${id}` : id;

    await this.wpb.collection("tasks").create({
      id,
      list: listId,
      parent_id: task.parentId || "",
      path,
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
    }, { $autoCancel: false });

    return id;
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
    await this.wpb.collection("tasks").update(taskId, data);
  }

  async deleteTask(taskId: string): Promise<void> {
    // Need the descendant set; query PB once for the path-prefix match.
    // (Local-cache-based descendant filtering is a v2 query-engine concern.)
    const task = await this.pb().collection("tasks").getOne(taskId);
    const descendants = await this.pb().collection("tasks").getFullList({
      filter: this.pb().filter("path ~ {:prefix}", { prefix: `${task.path}/%` }),
      $autoCancel: false,
    });
    // Delete deepest first to avoid orphans mid-cascade.
    descendants.sort((a, b) => b.path.length - a.path.length);
    for (const d of descendants) {
      await this.wpb.collection("tasks").delete(d.id);
    }
    await this.wpb.collection("tasks").delete(taskId);
  }

  async moveTask(taskId: string, newParentId: string | null, position: number): Promise<void> {
    const task = await this.pb().collection("tasks").getOne(taskId);
    const oldPath = task.path;

    let newPath: string;
    if (newParentId) {
      const parentPath = await this.resolveParentPath(newParentId);
      newPath = parentPath ? `${parentPath}/${taskId}` : taskId;
    } else {
      newPath = taskId;
    }

    await this.wpb.collection("tasks").update(taskId, {
      parent_id: newParentId || "",
      path: newPath,
      position,
    });

    // Rewrite descendants' paths (server-side fetch; predicates against the
    // local cache aren't available in v1).
    const descendants = await this.pb().collection("tasks").getFullList({
      filter: this.pb().filter("path ~ {:prefix}", { prefix: `${oldPath}/%` }),
      $autoCancel: false,
    });
    for (const d of descendants) {
      const updatedPath = newPath + d.path.slice(oldPath.length);
      await this.wpb.collection("tasks").update(d.id, { path: updatedPath });
    }
  }

  async snoozeTask(taskId: string, until: Date): Promise<void> {
    await this.wpb.collection("tasks").update(taskId, { snoozed_until: until.toISOString() });
  }

  async unsnoozeTask(taskId: string): Promise<void> {
    await this.wpb.collection("tasks").update(taskId, { snoozed_until: null });
  }

  /**
   * Compute the latest event timestamp for a task from the local wpb queue.
   * Includes pending mutations (creates/updates/deletes), so the result
   * reflects the about-to-be-applied state. Returns null if no events.
   */
  private computeLastCompleted(taskId: string): string | null {
    const events = this.wpb.collection("task_events").viewCollection<RecordModel>(
      (r) => r.subject_id === taskId,
    );
    let max: string | null = null;
    for (const e of events) {
      const ts = e.timestamp as string | undefined;
      if (ts && (!max || ts > max)) max = ts;
    }
    return max;
  }

  /**
   * Sync `tasks.last_completed` with what the local event view says is latest.
   * Skips the network write if it would be a no-op. Caller must ensure the
   * relevant wpb mutation has already been pushed (so its effect is visible
   * in the local view).
   */
  private async syncLastCompleted(taskId: string): Promise<void> {
    const cached = this.wpb.collection("tasks").view<RecordModel>(taskId);
    const current = (cached?.last_completed as string | null) ?? null;
    const next = this.computeLastCompleted(taskId);
    if (current === next) return;
    await this.wpb.collection("tasks").update(taskId, { last_completed: next });
  }

  async completeTask(taskId: string, userId: string, options?: { notes?: string; completedAt?: Date }): Promise<void> {
    const timestamp = (options?.completedAt ?? new Date()).toISOString();
    const cached = this.wpb.collection("tasks").view<RecordModel>(taskId);
    const listId = cached?.list as string | undefined;
    const list = listId ?? (await this.pb().collection("tasks").getOne(taskId)).list;

    // Push the event into wpb (synchronously visible in the local view).
    const eventCreate = this.wpb.collection("task_events").create({
      id: newId(),
      list,
      subject_id: taskId,
      timestamp,
      created_by: userId,
      data: options?.notes ? { notes: options.notes } : {},
    });
    // Now syncLastCompleted scans the queue (including the just-pushed event)
    // and only fires a tasks.update if the value actually changed.
    await Promise.all([eventCreate, this.syncLastCompleted(taskId)]);
  }

  async toggleComplete(taskId: string): Promise<void> {
    const cached = this.wpb.collection("tasks").view<RecordModel>(taskId);
    const current = cached ? !!cached.completed : (await this.pb().collection("tasks").getOne(taskId)).completed;
    await this.wpb.collection("tasks").update(taskId, { completed: !current });
  }

  async toggleTaskNotification(taskId: string, userId: string, enable: boolean): Promise<void> {
    if (enable) {
      await this.wpb.collection("tasks").update(taskId, { "notify_users+": userId });
    } else {
      await this.wpb.collection("tasks").update(taskId, { "notify_users-": userId });
    }
  }

  async toggleCollapsed(taskId: string): Promise<void> {
    const cached = this.wpb.collection("tasks").view<RecordModel>(taskId);
    const current = cached ? !!cached.collapsed : (await this.pb().collection("tasks").getOne(taskId)).collapsed;
    await this.wpb.collection("tasks").update(taskId, { collapsed: !current });
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
    const subtree = await this.getSubtree(templateRootId);
    subtree.sort((a, b) => a.path.length - b.path.length);

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
        tags: tags.filter((t) => !t.startsWith("template:")),
        collapsed: task.collapsed,
      });
      idMap.set(task.id, newId);
    }

    return idMap.get(subtree[0].id)!;
  }

  async updateCompletion(eventId: string, updates: { notes?: string; timestamp?: Date }): Promise<void> {
    const cached = this.wpb.collection("task_events").view<RecordModel>(eventId);
    const record: RecordModel = cached ?? await this.pb().collection("task_events").getOne(eventId);
    const data: Record<string, unknown> = {};
    if (updates.timestamp) data.timestamp = updates.timestamp.toISOString();
    if (updates.notes !== undefined) {
      const existing = (record.data as Record<string, unknown>) || {};
      data.data = { ...existing, notes: updates.notes.trim() || undefined };
    }
    const eventUpdate = this.wpb.collection("task_events").update(eventId, data);
    if (updates.timestamp !== undefined) {
      await Promise.all([eventUpdate, this.syncLastCompleted(record.subject_id as string)]);
    } else {
      await eventUpdate;
    }
  }

  async deleteCompletion(eventId: string): Promise<void> {
    const cached = this.wpb.collection("task_events").view<RecordModel>(eventId);
    const record: RecordModel = cached ?? await this.pb().collection("task_events").getOne(eventId);
    const subjectId = record.subject_id as string;
    // Push the delete (queue reflects it immediately), then sync.
    const eventDelete = this.wpb.collection("task_events").delete(eventId);
    await Promise.all([eventDelete, this.syncLastCompleted(subjectId)]);
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
    const completionsMap = new Map<string, TaskCompletion>();

    const emitTasks = () => {
      if (!cancelled) handlers.onTasks(Array.from(tasksMap.values()));
    };
    const emitCompletions = () => {
      if (cancelled) return;
      // UI expects newest first, matching the prior `-timestamp` sort.
      const list = Array.from(completionsMap.values()).sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
      );
      handlers.onCompletions(list);
    };

    // List metadata — optimistic-aware via wpb.
    this.initSubscribeToRecord("task_lists", listId, isCancelled, unsubs, {
      onData: (r) => handlers.onList(listFromRecord(r)),
      onDelete: () => handlers.onDeleted?.(),
    });

    // Tasks — optimistic-aware via wpb with predicate.
    this.initSubscribeToCollection("tasks", isCancelled, unsubs, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      belongsTo: (r) => r.list === listId,
      onInitial: (records) => { for (const r of records) tasksMap.set(r.id, taskFromRecord(r)); emitTasks(); },
      onChange: (action, r) => {
        if (action === "delete") tasksMap.delete(r.id); else tasksMap.set(r.id, taskFromRecord(r));
        emitTasks();
      },
    });

    // Completions — per-record via wpb so events land in the optimistic queue
    // (lets `computeLastCompleted` scan locally without a server round-trip).
    this.initSubscribeToCollection("task_events", isCancelled, unsubs, {
      filter: this.pb().filter("list = {:listId}", { listId }),
      belongsTo: (r) => r.list === listId,
      onInitial: (records) => { for (const r of records) completionsMap.set(r.id, completionFromRecord(r)); emitCompletions(); },
      onChange: (action, r) => {
        if (action === "delete") completionsMap.delete(r.id); else completionsMap.set(r.id, completionFromRecord(r));
        emitCompletions();
      },
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
    this.wpb.collection(col).subscribe(id, (e) => {
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
    }).catch((e) => { if (!cancelled()) console.warn(`[upkeep] subCol ${col} failed`, e); });
    this.wpb.collection(col).subscribe("*", (e) => {
      if (cancelled() || !opts.belongsTo(e.record)) return;
      opts.onChange(e.action, e.record);
    }, { local: (r) => opts.belongsTo(r as RecordModel) }).then((unsub) => unsubs.push(unsub));
  }

}
