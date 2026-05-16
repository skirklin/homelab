/**
 * Supabase implementation of UpkeepBackend (unified task system).
 *
 * Tree structure: same materialized-path model as PB. `path` is a
 * slash-separated string of task UUIDs; descendants of <p> match
 * `path LIKE '<p>/%'`. Phase 2's btree index on `path` supports this.
 *
 * Realtime: per-list channel watching task_lists / tasks / task_events.
 * Task notify_users is a junction table; on a task change we re-fetch
 * the task with its notify_users join so the emitted Task carries the
 * full array. Acceptable extra round-trip for a relatively rare change.
 *
 * `addTask` resolves the parent's path with a single SELECT; falls back
 * to `id` (root) if none.
 *
 * Last-completed sync: kept simple — after creating/updating/deleting a
 * task_event we re-derive the maximum timestamp for that task's events
 * server-side and patch tasks.last_completed accordingly.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { TaskList, Task, TaskCompletion, Frequency, TaskType } from "../types/upkeep";
import type { Unsubscribe } from "../types/common";

// ---- Row shapes --------------------------------------------------------

interface ListRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  task_list_owners?: Array<{ user_id: string }>;
}

interface TaskRow {
  id: string;
  list_id: string;
  parent_id: string | null;
  path: string | null;
  position: number | null;
  name: string;
  description: string | null;
  frequency: Frequency | null;
  last_completed: string | null;
  snoozed_until: string | null;
  created_by: string | null;
  task_type: TaskType | null;
  completed: boolean | null;
  tags: string[] | null;
  collapsed: boolean | null;
  created_at: string;
  updated_at: string;
  task_notify_users?: Array<{ user_id: string }>;
}

interface TaskEventRow {
  id: string;
  list_id: string;
  subject_id: string;
  timestamp: string;
  created_by: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// ---- Mappers -----------------------------------------------------------

function listFromRow(r: ListRow): TaskList {
  return {
    id: r.id,
    name: r.name,
    owners: r.task_list_owners?.map((o) => o.user_id) ?? [],
    created: r.created_at,
    updated: r.updated_at,
  };
}

function taskFromRow(r: TaskRow): Task {
  return {
    id: r.id,
    list: r.list_id,
    parentId: r.parent_id ?? "",
    path: r.path ?? r.id,
    position: r.position ?? 0,
    name: r.name,
    description: r.description ?? "",
    taskType: (r.task_type ?? "recurring") as TaskType,
    frequency: r.frequency ?? ({ value: 0, unit: "days" } as Frequency),
    lastCompleted: r.last_completed ? new Date(r.last_completed) : null,
    completed: !!r.completed,
    snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until) : null,
    notifyUsers: r.task_notify_users?.map((n) => n.user_id) ?? [],
    createdBy: r.created_by ?? "",
    tags: r.tags ?? [],
    collapsed: !!r.collapsed,
    created: r.created_at,
    updated: r.updated_at,
  };
}

function completionFromRow(r: TaskEventRow): TaskCompletion {
  return {
    id: r.id,
    subjectId: r.subject_id,
    timestamp: new Date(r.timestamp),
    createdAt: new Date(r.created_at),
    createdBy: r.created_by ?? "",
    data: r.data ?? {},
  };
}

const TASK_SELECT = "*, task_notify_users(user_id)";
const LIST_SELECT = "*, task_list_owners(user_id)";

// ---- Backend impl ------------------------------------------------------

export class SupabaseUpkeepBackend implements UpkeepBackend {
  constructor(private client: SupabaseClient) {}

  // ----- List CRUD -------------------------------------------------------

  async createList(name: string, userId: string): Promise<string> {
    const { data: list, error: listErr } = await this.client
      .from("task_lists")
      .insert({ name })
      .select("id")
      .single();
    if (listErr) throw listErr;

    const { error: ownerErr } = await this.client
      .from("task_list_owners")
      .insert({ list_id: list.id, user_id: userId });
    if (ownerErr) {
      await this.client.from("task_lists").delete().eq("id", list.id);
      throw ownerErr;
    }
    return list.id;
  }

  async renameList(listId: string, name: string): Promise<void> {
    const { error } = await this.client.from("task_lists").update({ name }).eq("id", listId);
    if (error) throw error;
  }

  async deleteList(listId: string): Promise<void> {
    const { error } = await this.client.from("task_lists").delete().eq("id", listId);
    if (error) throw error;
  }

  async getList(listId: string): Promise<TaskList | null> {
    const { data, error } = await this.client
      .from("task_lists")
      .select(LIST_SELECT)
      .eq("id", listId)
      .maybeSingle();
    if (error || !data) return null;
    return listFromRow(data as ListRow);
  }

  // ----- Task CRUD (tree-aware) ------------------------------------------

  private async resolveParentPath(parentId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from("tasks")
      .select("path, id")
      .eq("id", parentId)
      .maybeSingle();
    if (error || !data) return null;
    return data.path || data.id;
  }

  async addTask(
    listId: string,
    task: Omit<Task, "id" | "list" | "path" | "created" | "updated" | "createdBy">,
  ): Promise<string> {
    // Pre-allocate the UUID so we can write the materialized path in the
    // same insert. (PG will accept a client-supplied id; the default just
    // wraps gen_random_uuid().)
    const newId = crypto.randomUUID();
    const parentPath = task.parentId ? await this.resolveParentPath(task.parentId) : null;
    const path = parentPath ? `${parentPath}/${newId}` : newId;

    const { error } = await this.client.from("tasks").insert({
      id: newId,
      list_id: listId,
      parent_id: task.parentId || null,
      path,
      position: task.position ?? 0,
      name: task.name,
      description: task.description ?? "",
      task_type: task.taskType ?? "recurring",
      frequency: task.frequency,
      last_completed: task.lastCompleted?.toISOString() ?? null,
      completed: !!task.completed,
      snoozed_until: null,
      tags: task.tags ?? [],
      collapsed: false,
    });
    if (error) throw error;

    if (task.notifyUsers && task.notifyUsers.length > 0) {
      const rows = task.notifyUsers.map((uid) => ({ task_id: newId, user_id: uid }));
      const { error: nErr } = await this.client.from("task_notify_users").insert(rows);
      if (nErr) throw nErr;
    }
    return newId;
  }

  async updateTask(
    taskId: string,
    updates: Partial<Omit<Task, "id" | "list" | "path" | "created" | "updated" | "createdBy">>,
  ): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.taskType !== undefined) patch.task_type = updates.taskType;
    if (updates.frequency !== undefined) patch.frequency = updates.frequency;
    if (updates.lastCompleted !== undefined) {
      patch.last_completed = updates.lastCompleted?.toISOString() ?? null;
    }
    if (updates.completed !== undefined) patch.completed = updates.completed;
    if (updates.snoozedUntil !== undefined) {
      patch.snoozed_until = updates.snoozedUntil?.toISOString() ?? null;
    }
    if (updates.tags !== undefined) patch.tags = updates.tags;
    if (updates.collapsed !== undefined) patch.collapsed = updates.collapsed;
    if (updates.position !== undefined) patch.position = updates.position;
    if (updates.parentId !== undefined) patch.parent_id = updates.parentId || null;
    if (Object.keys(patch).length > 0) {
      const { error } = await this.client.from("tasks").update(patch).eq("id", taskId);
      if (error) throw error;
    }
    if (updates.notifyUsers !== undefined) {
      await this.replaceNotifyUsers(taskId, updates.notifyUsers);
    }
  }

  private async replaceNotifyUsers(taskId: string, userIds: string[]): Promise<void> {
    const { error: delErr } = await this.client
      .from("task_notify_users")
      .delete()
      .eq("task_id", taskId);
    if (delErr) throw delErr;
    if (userIds.length === 0) return;
    const rows = userIds.map((uid) => ({ task_id: taskId, user_id: uid }));
    const { error: insErr } = await this.client.from("task_notify_users").insert(rows);
    if (insErr) throw insErr;
  }

  async deleteTask(taskId: string): Promise<void> {
    // Cascade handles task_notify_users + children-via-path? No — `path` is
    // a string, not a FK. We need to find descendants and delete them
    // explicitly. The tasks row's own FK doesn't cascade to "siblings of
    // same path prefix" because that's not a real relation.
    const { data: task, error: readErr } = await this.client
      .from("tasks")
      .select("path")
      .eq("id", taskId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!task) return;

    const prefix = `${task.path ?? taskId}/`;
    const { data: descendants, error: descErr } = await this.client
      .from("tasks")
      .select("id, path")
      .like("path", `${prefix}%`);
    if (descErr) throw descErr;

    // Delete deepest-first to avoid any path-prefix surprises.
    const ids = (descendants ?? []).slice().sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0)).map((d) => d.id);
    if (ids.length > 0) {
      const { error: delErr } = await this.client.from("tasks").delete().in("id", ids);
      if (delErr) throw delErr;
    }
    const { error } = await this.client.from("tasks").delete().eq("id", taskId);
    if (error) throw error;
  }

  async moveTask(taskId: string, newParentId: string | null, position: number): Promise<void> {
    const { data: task, error: readErr } = await this.client
      .from("tasks")
      .select("path")
      .eq("id", taskId)
      .single();
    if (readErr) throw readErr;
    const oldPath = task.path ?? taskId;

    let newPath: string;
    if (newParentId) {
      const parentPath = await this.resolveParentPath(newParentId);
      newPath = parentPath ? `${parentPath}/${taskId}` : taskId;
    } else {
      newPath = taskId;
    }

    const { error: moveErr } = await this.client
      .from("tasks")
      .update({ parent_id: newParentId || null, path: newPath, position })
      .eq("id", taskId);
    if (moveErr) throw moveErr;

    // Rewrite descendants' paths.
    const { data: descendants } = await this.client
      .from("tasks")
      .select("id, path")
      .like("path", `${oldPath}/%`);
    if (!descendants) return;
    for (const d of descendants) {
      const updated = newPath + (d.path ?? "").slice(oldPath.length);
      const { error } = await this.client.from("tasks").update({ path: updated }).eq("id", d.id);
      if (error) throw error;
    }
  }

  // ----- Task actions ----------------------------------------------------

  async snoozeTask(taskId: string, until: Date): Promise<void> {
    const { error } = await this.client
      .from("tasks")
      .update({ snoozed_until: until.toISOString() })
      .eq("id", taskId);
    if (error) throw error;
  }

  async unsnoozeTask(taskId: string): Promise<void> {
    const { error } = await this.client
      .from("tasks")
      .update({ snoozed_until: null })
      .eq("id", taskId);
    if (error) throw error;
  }

  async completeTask(
    taskId: string,
    userId: string,
    options?: { notes?: string; completedAt?: Date },
  ): Promise<void> {
    const timestamp = (options?.completedAt ?? new Date()).toISOString();
    const { data: parent, error: readErr } = await this.client
      .from("tasks")
      .select("list_id")
      .eq("id", taskId)
      .single();
    if (readErr) throw readErr;

    const { error: eventErr } = await this.client.from("task_events").insert({
      list_id: parent.list_id,
      subject_id: taskId,
      timestamp,
      created_by: userId,
      data: options?.notes ? { notes: options.notes } : {},
    });
    if (eventErr) throw eventErr;

    await this.syncLastCompleted(taskId);
  }

  async toggleComplete(taskId: string): Promise<void> {
    const { data, error: readErr } = await this.client
      .from("tasks")
      .select("completed")
      .eq("id", taskId)
      .single();
    if (readErr) throw readErr;
    const { error } = await this.client
      .from("tasks")
      .update({ completed: !data.completed })
      .eq("id", taskId);
    if (error) throw error;
  }

  async toggleTaskNotification(
    taskId: string,
    userId: string,
    enable: boolean,
  ): Promise<void> {
    if (enable) {
      const { error } = await this.client
        .from("task_notify_users")
        .upsert(
          { task_id: taskId, user_id: userId },
          { onConflict: "task_id,user_id" },
        );
      if (error) throw error;
    } else {
      const { error } = await this.client
        .from("task_notify_users")
        .delete()
        .eq("task_id", taskId)
        .eq("user_id", userId);
      if (error) throw error;
    }
  }

  async toggleCollapsed(taskId: string): Promise<void> {
    const { data, error: readErr } = await this.client
      .from("tasks")
      .select("collapsed")
      .eq("id", taskId)
      .single();
    if (readErr) throw readErr;
    const { error } = await this.client
      .from("tasks")
      .update({ collapsed: !data.collapsed })
      .eq("id", taskId);
    if (error) throw error;
  }

  // ----- Tree queries ----------------------------------------------------

  async getSubtree(rootTaskId: string): Promise<Task[]> {
    const { data: root, error: rootErr } = await this.client
      .from("tasks")
      .select(TASK_SELECT)
      .eq("id", rootTaskId)
      .single();
    if (rootErr) throw rootErr;
    const rootPath = (root.path as string) ?? rootTaskId;

    const { data: descendants, error: descErr } = await this.client
      .from("tasks")
      .select(TASK_SELECT)
      .like("path", `${rootPath}/%`);
    if (descErr) throw descErr;
    return [root as TaskRow, ...((descendants ?? []) as TaskRow[])].map(taskFromRow);
  }

  async getTasksByTag(listId: string, tag: string): Promise<Task[]> {
    // tags is jsonb; `contains` matches arrays containing the given value.
    const { data, error } = await this.client
      .from("tasks")
      .select(TASK_SELECT)
      .eq("list_id", listId)
      .contains("tags", JSON.stringify([tag]));
    if (error || !data) return [];
    return (data as TaskRow[]).map(taskFromRow);
  }

  async instantiateTemplate(templateRootId: string, tags: string[]): Promise<string> {
    const subtree = await this.getSubtree(templateRootId);
    subtree.sort((a, b) => a.path.length - b.path.length);

    const idMap = new Map<string, string>();
    for (const task of subtree) {
      const newParentId = task.parentId ? idMap.get(task.parentId) ?? "" : "";
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

  // ----- Completion history ---------------------------------------------

  async updateCompletion(
    eventId: string,
    updates: { notes?: string; timestamp?: Date },
  ): Promise<void> {
    const { data: row, error: readErr } = await this.client
      .from("task_events")
      .select("subject_id, data")
      .eq("id", eventId)
      .single();
    if (readErr) throw readErr;

    const patch: Record<string, unknown> = {};
    if (updates.timestamp) patch.timestamp = updates.timestamp.toISOString();
    if (updates.notes !== undefined) {
      const existing = (row.data as Record<string, unknown>) ?? {};
      const trimmed = updates.notes.trim();
      patch.data = trimmed ? { ...existing, notes: trimmed } : { ...existing, notes: undefined };
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await this.client.from("task_events").update(patch).eq("id", eventId);
      if (error) throw error;
    }
    if (updates.timestamp !== undefined) {
      await this.syncLastCompleted(row.subject_id as string);
    }
  }

  async deleteCompletion(eventId: string): Promise<void> {
    const { data: row, error: readErr } = await this.client
      .from("task_events")
      .select("subject_id")
      .eq("id", eventId)
      .single();
    if (readErr) throw readErr;
    const subjectId = row.subject_id as string;

    const { error: delErr } = await this.client.from("task_events").delete().eq("id", eventId);
    if (delErr) throw delErr;
    await this.syncLastCompleted(subjectId);
  }

  /**
   * Recompute the latest task_event.timestamp for the task and patch
   * tasks.last_completed accordingly. Skips the write if it would be a
   * no-op.
   */
  private async syncLastCompleted(taskId: string): Promise<void> {
    const { data: latestRows } = await this.client
      .from("task_events")
      .select("timestamp")
      .eq("subject_id", taskId)
      .order("timestamp", { ascending: false })
      .limit(1);
    const next = latestRows && latestRows.length > 0 ? latestRows[0].timestamp as string : null;

    const { data: current } = await this.client
      .from("tasks")
      .select("last_completed")
      .eq("id", taskId)
      .maybeSingle();
    if (!current) return;
    if ((current.last_completed ?? null) === next) return;
    const { error } = await this.client
      .from("tasks")
      .update({ last_completed: next })
      .eq("id", taskId);
    if (error) throw error;
  }

  // ----- Subscriptions --------------------------------------------------

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
    const tasksMap = new Map<string, Task>();
    const completionsMap = new Map<string, TaskCompletion>();

    const emitTasks = () => {
      if (!cancelled) handlers.onTasks(Array.from(tasksMap.values()));
    };
    const emitCompletions = () => {
      if (cancelled) return;
      const list = Array.from(completionsMap.values()).sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
      );
      handlers.onCompletions(list);
    };

    const reloadTask = async (taskId: string) => {
      const { data } = await this.client
        .from("tasks")
        .select(TASK_SELECT)
        .eq("id", taskId)
        .maybeSingle();
      if (cancelled || !data) return;
      tasksMap.set(taskId, taskFromRow(data as TaskRow));
      emitTasks();
    };

    const reloadList = async () => {
      const { data } = await this.client
        .from("task_lists")
        .select(LIST_SELECT)
        .eq("id", listId)
        .maybeSingle();
      if (cancelled || !data) return;
      handlers.onList(listFromRow(data as ListRow));
    };

    const channel: RealtimeChannel = this.client
      .channel(`upkeep-list-${listId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "task_lists", filter: `id=eq.${listId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") handlers.onDeleted?.();
          else void reloadList();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks", filter: `list_id=eq.${listId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<TaskRow>;
            if (old.id) tasksMap.delete(old.id);
            emitTasks();
            return;
          }
          const row = payload.new as TaskRow;
          void reloadTask(row.id);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "task_events", filter: `list_id=eq.${listId}` },
        (payload) => {
          if (cancelled) return;
          if (payload.eventType === "DELETE") {
            const old = payload.old as Partial<TaskEventRow>;
            if (old.id) completionsMap.delete(old.id);
          } else {
            const row = payload.new as TaskEventRow;
            completionsMap.set(row.id, completionFromRow(row));
          }
          emitCompletions();
        },
      )
      // task_notify_users: when a notify_users row changes, the affected
      // task row hasn't (yet); re-fetch the task so its `notifyUsers` array
      // is fresh.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "task_notify_users" },
        (payload) => {
          if (cancelled) return;
          const newRow = payload.new as { task_id?: string } | null;
          const oldRow = payload.old as { task_id?: string } | null;
          const taskId = newRow?.task_id ?? oldRow?.task_id;
          if (!taskId || !tasksMap.has(taskId)) return; // not one of ours
          void reloadTask(taskId);
        },
      )
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED" || cancelled) return;
        const [{ data: tasks }, { data: events }] = await Promise.all([
          this.client.from("tasks").select(TASK_SELECT).eq("list_id", listId),
          this.client.from("task_events").select("*").eq("list_id", listId),
        ]);
        if (cancelled) return;
        tasksMap.clear();
        completionsMap.clear();
        if (tasks) for (const t of tasks as TaskRow[]) tasksMap.set(t.id, taskFromRow(t));
        if (events) for (const e of events as TaskEventRow[]) completionsMap.set(e.id, completionFromRow(e));
        emitTasks();
        emitCompletions();
        await reloadList();
      });

    return () => {
      cancelled = true;
      void this.client.removeChannel(channel);
    };
  }
}
