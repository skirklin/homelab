/**
 * PocketBase implementation of UpkeepBackend (unified task system).
 *
 * Writes route through the optimistic wrapper. addTask collapses the
 * old 3-RTT (create → fetch parent → update path) flow into a single
 * create with a client-computed path — the parent is read from the
 * wpb's in-memory queue, which the active subscription has already
 * populated. Falls back to a 1-extra-fetch path if the parent isn't
 * cached (e.g. deep link), still beating the original 3 RTTs.
 *
 * subscribeToList rides on the PBMirror: three slices (the task_list
 * record, tasks filtered by list, task_events filtered by list). The
 * mirror absorbs every cancel-before-resolve, ref-counts the SSE
 * channel per collection, and delivers full state per slice — so the
 * old bespoke `initSubscribeToRecord` / `initSubscribeToCollection`
 * helpers + buffer-then-emit dance retire here.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { TaskList, Task, TaskCompletion } from "../types/upkeep";
import type { LifeEntry } from "../types/life";
import type { Unsubscribe } from "../types/common";
import { newId } from "../wrapped-pb/ids";
import type { WrappedPocketBase } from "../wrapped-pb";
import type { PBMirror, RawRecord } from "../wrapped-pb/mirror";

/**
 * Defensive parser for the post-migration task_events.entries column.
 * Mirrors apps/life/.../life.ts so a half-deployed env or hand-edited row
 * can't crash the UI.
 */
function entriesFromRecord(r: RecordModel | RawRecord): LifeEntry[] {
  const x = r as Record<string, unknown>;
  const raw = Array.isArray(x.entries) ? x.entries : [];
  const out: LifeEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    if (e.type === "text" && typeof e.value === "string") {
      out.push({ name: e.name, type: "text", value: e.value });
    } else if (e.type === "number" && typeof e.value === "number" && typeof e.unit === "string") {
      const entry: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
      if (typeof e.scale === "number") entry.scale = e.scale;
      out.push(entry);
    } else if (e.type === "bool" && typeof e.value === "boolean") {
      out.push({ name: e.name, type: "bool", value: e.value });
    }
  }
  return out;
}

function labelsFromRecord(r: RecordModel | RawRecord): Record<string, string> | undefined {
  const x = r as Record<string, unknown>;
  return x.labels && typeof x.labels === "object" && !Array.isArray(x.labels)
    ? (x.labels as Record<string, string>)
    : undefined;
}

function notesEntries(notes?: string): LifeEntry[] {
  const trimmed = notes?.trim();
  return trimmed ? [{ name: "notes", type: "text", value: trimmed }] : [];
}

function listFromRecord(r: RecordModel | RawRecord): TaskList {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    name: (x.name as string) || "",
    owners: Array.isArray(x.owners) ? (x.owners as string[]) : [],
    created: x.created as string,
    updated: x.updated as string,
  };
}

function taskFromRecord(r: RecordModel | RawRecord): Task {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    list: x.list as string,
    parentId: (x.parent_id as string) || "",
    path: (x.path as string) || r.id,
    position: (x.position as number) ?? 0,
    name: (x.name as string) || "",
    description: (x.description as string) || "",
    taskType: (x.task_type as Task["taskType"]) || "recurring",
    // Schema/type mismatch: backend Task declares `frequency: Frequency` but
    // PB stores it as either an object or a number; preserve the original
    // pass-through behavior (`r.frequency || 0`) here.
    frequency: (x.frequency || 0) as Task["frequency"],
    lastCompleted: x.last_completed ? new Date(x.last_completed as string) : null,
    deadline: x.deadline ? new Date(x.deadline as string) : null,
    deadlineLeadDays: (x.deadline_lead_days as number) ?? null,
    completed: !!x.completed,
    snoozedUntil: x.snoozed_until ? new Date(x.snoozed_until as string) : null,
    assignees: Array.isArray(x.assignees) ? (x.assignees as string[]) : [],
    createdBy: (x.created_by as string) || "",
    tags: Array.isArray(x.tags) ? (x.tags as string[]) : [],
    collapsed: !!x.collapsed,
    cleared: !!x.cleared,
    created: x.created as string,
    updated: x.updated as string,
  };
}

function completionFromRecord(r: RecordModel | RawRecord): TaskCompletion {
  const x = r as Record<string, unknown>;
  return {
    id: r.id,
    subjectId: (x.subject_id as string) || "",
    timestamp: new Date(x.timestamp as string),
    endTime: x.end_time ? new Date(x.end_time as string) : undefined,
    entries: entriesFromRecord(r),
    labels: labelsFromRecord(r),
    createdBy: (x.created_by as string) || "",
    created: x.created as string,
    updated: x.updated as string,
  };
}

export class PocketBaseUpkeepBackend implements UpkeepBackend {
  private wpb: WrappedPocketBase;
  private mirror: PBMirror;

  constructor(private pb: () => PocketBase, wpb: WrappedPocketBase, mirror: PBMirror) {
    this.wpb = wpb;
    this.mirror = mirror;
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

    // Stamp created_by from the client's own authenticated identity (never a
    // caller-supplied value). This is the terminal floor of the notify
    // cascade — without it, UI-created tasks degrade to notifying every list
    // owner. The wpb create carries it so the optimistic overlay matches what
    // lands server-side.
    const createdBy = this.pb().authStore.record?.id ?? "";

    // assignees is the sole notification driver. Persist exactly what the
    // caller passed (empty when omitted) — do NOT default to the creator.
    // Under the inherit model an empty-assignees task resolves via the cascade
    // (nearest assigned ancestor → created_by floor → list.owners), matching
    // POST /tasks so UI- and API-created tasks behave the same.
    const assignees = task.assignees ?? [];

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
      deadline: task.deadline?.toISOString() || null,
      deadline_lead_days: task.deadlineLeadDays ?? null,
      completed: task.completed || false,
      snoozed_until: null,
      assignees,
      created_by: createdBy,
      tags: task.tags || [],
      collapsed: false,
      cleared: false,
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
    if (updates.deadline !== undefined) data.deadline = updates.deadline?.toISOString() || null;
    if (updates.deadlineLeadDays !== undefined) data.deadline_lead_days = updates.deadlineLeadDays ?? null;
    if (updates.completed !== undefined) data.completed = updates.completed;
    if (updates.snoozedUntil !== undefined) data.snoozed_until = updates.snoozedUntil?.toISOString() || null;
    if (updates.assignees !== undefined) data.assignees = updates.assignees;
    if (updates.tags !== undefined) data.tags = updates.tags;
    if (updates.collapsed !== undefined) data.collapsed = updates.collapsed;
    if (updates.cleared !== undefined) data.cleared = updates.cleared;
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
   * Routes through the transactional PB hook at
   * `infra/pocketbase/pb_hooks/task_tags.pb.js` (POST /api/tasks/:id/tags).
   * The hook reads + merges + writes the tags column inside a single SQL
   * transaction via `$app.runInTransaction`, which closes the cross-device
   * race that the previous read-then-write impl couldn't: two devices
   * adding different tags at the same instant now both land instead of
   * one stomping the other.
   *
   * No optimistic local update here — the wpb queue can't safely model
   * "merge what the server has" without already knowing the server state,
   * and a `wpb.update({ tags: predicted })` would fire its own PATCH that
   * races the hook's transactional write. The realtime echo from the
   * hook's save arrives over the existing subscription within ~100ms and
   * settles the UI; the brief same-client latency is the cost of the
   * cross-device correctness gain.
   */
  async tagTask(taskId: string, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    const add = opts.add ?? [];
    const remove = opts.remove ?? [];
    if (add.length === 0 && remove.length === 0) return;

    await this.pb().send(`/api/tasks/${encodeURIComponent(taskId)}/tags`, {
      method: "POST",
      body: JSON.stringify({ add, remove }),
      headers: { "Content-Type": "application/json" },
    });
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
      entries: notesEntries(options?.notes),
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
      await this.wpb.collection("tasks").update(taskId, { "assignees+": userId });
    } else {
      await this.wpb.collection("tasks").update(taskId, { "assignees-": userId });
    }
  }

  async toggleCollapsed(taskId: string): Promise<void> {
    const cached = this.wpb.collection("tasks").view<RecordModel>(taskId);
    const current = cached ? !!cached.collapsed : (await this.pb().collection("tasks").getOne(taskId)).collapsed;
    await this.wpb.collection("tasks").update(taskId, { collapsed: !current });
  }

  async clearDoneTasks(listId: string): Promise<{ clearedCount: number }> {
    // Prefer the local wpb cache (the active subscription has it populated
    // with every task in the list, including any optimistic mutations).
    // Falls back to a server fetch only if the cache holds nothing for this
    // list — keeps this callable from an MCP context that never subscribed,
    // without spuriously refetching when the cache is hot and simply has no
    // matches.
    const cached = this.wpb.collection("tasks").viewCollection<RecordModel>(
      (r) => r.list === listId,
    );
    const targets: RecordModel[] = cached.length > 0
      ? cached.filter(
          (r) => r.task_type === "one_shot" && !!r.completed && !r.cleared,
        )
      : await this.pb().collection("tasks").getFullList({
          filter: this.pb().filter(
            "list = {:listId} && task_type = 'one_shot' && completed = true && cleared != true",
            { listId },
          ),
          $autoCancel: false,
        });

    if (targets.length === 0) return { clearedCount: 0 };
    await Promise.all(
      targets.map((t) => this.wpb.collection("tasks").update(t.id, { cleared: true })),
    );
    return { clearedCount: targets.length };
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
        deadline: task.deadline,
        deadlineLeadDays: task.deadlineLeadDays,
        completed: false,
        snoozedUntil: null,
        assignees: [],
        tags: tags.filter((t) => !t.startsWith("template:")),
        collapsed: task.collapsed,
        cleared: false,
      });
      idMap.set(task.id, newId);
    }

    return idMap.get(subtree[0].id)!;
  }

  async updateCompletion(eventId: string, updates: { notes?: string; timestamp?: Date }): Promise<void> {
    const cached = this.wpb.collection("task_events").view<RecordModel>(eventId);
    const record: RecordModel = cached ?? await this.pb().collection("task_events").getOne(eventId);
    const patch: Record<string, unknown> = {};
    if (updates.timestamp) patch.timestamp = updates.timestamp.toISOString();
    if (updates.notes !== undefined) {
      // Replace any existing "notes" entry, preserving every other entry the
      // row might carry (no current writers add others, but a hand-edited row
      // shouldn't lose them on a notes edit).
      const existing = entriesFromRecord(record).filter((e) => !(e.name === "notes" && e.type === "text"));
      patch.entries = [...existing, ...notesEntries(updates.notes)];
    }
    const eventUpdate = this.wpb.collection("task_events").update(eventId, patch);
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
    // Track first-observed-existing so an initial 404 on the list doesn't
    // misfire onDeleted (same pattern as shopping.subscribeToList).
    let listKnownExisted = false;

    const listHandle = this.mirror.watch(
      { collection: "task_lists", topic: listId },
      (records) => {
        if (records.length === 0) {
          if (listKnownExisted) handlers.onDeleted?.();
          return;
        }
        listKnownExisted = true;
        handlers.onList(listFromRecord(records[0]));
      },
    );

    const tasksHandle = this.mirror.watch(
      {
        collection: "tasks",
        topic: "*",
        filter: this.pb().filter("list = {:listId}", { listId }),
        predicate: (r) => r.list === listId,
      },
      (records) => {
        handlers.onTasks(records.map(taskFromRecord));
      },
    );

    // Completions land in the queue too — `computeLastCompleted` reads
    // through the same queue view, so the local sync works without a
    // server round-trip.
    const completionsHandle = this.mirror.watch(
      {
        collection: "task_events",
        topic: "*",
        filter: this.pb().filter("list = {:listId}", { listId }),
        predicate: (r) => r.list === listId,
      },
      (records) => {
        // UI expects newest first, matching the prior `-timestamp` sort.
        const list = records
          .map(completionFromRecord)
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        handlers.onCompletions(list);
      },
    );

    return () => {
      listHandle.unsubscribe();
      tasksHandle.unsubscribe();
      completionsHandle.unsubscribe();
    };
  }
}
