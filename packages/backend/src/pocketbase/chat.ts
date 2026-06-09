/**
 * PocketBase implementation of ChatBackend. Renamed from `coach` before any
 * deploy; user-facing name is "Chat".
 *
 * Reads/writes are still plain PB SDK calls (messages are infrequent and the
 * panel writes via the API service, not wpb). The subscription path, though,
 * rides PBMirror — same canonical realtime engine shopping/life use — so the
 * coach's server-side assistant replies and any future cross-tab writes
 * stream into the UI without a manual refetch.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type {
  ChatBackend,
  ListChatMessagesOptions,
  PostChatMessageInput,
} from "../interfaces/chat";
import type {
  ChatMessage,
  ChatMessageKind,
  ChatMessageRole,
} from "../types/chat";
import type { Unsubscribe } from "../types/common";
import type { PBMirror, RawRecord } from "../wrapped-pb/mirror";

const VALID_KINDS: ReadonlySet<ChatMessageKind> = new Set([
  "chat",
  "question",
  "deploy_request",
  "feedback",
  "note",
]);

function messageFromRecord(r: RecordModel | RawRecord): ChatMessage {
  const x = r as Record<string, unknown>;
  // `meta` may be a plain object (SDK-parsed JSON), null, or undefined for
  // pre-existing rows where the field wasn't set. Coerce defensively;
  // anything non-object collapses to null so callers don't have to
  // discriminate. (Goja-side byte-array shape only surfaces in migrations
  // — the JS SDK parses JSON columns at the transport layer.)
  const rawMeta = x.meta;
  const meta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
      ? (rawMeta as Record<string, unknown>)
      : null;

  // `thread_id` may be missing on a row that pre-dates the schema migration
  // if the row was read before the backfill landed. Fall back to "pm"
  // defensively so a transient half-applied DB never produces an empty
  // threadId on a typed record. Steady state: the PB column is required +
  // min:1 so this branch is unreachable in prod.
  const rawThreadId = x.thread_id;
  const threadId =
    typeof rawThreadId === "string" && rawThreadId.length > 0 ? rawThreadId : "pm";

  return {
    id: r.id,
    owner: x.owner as string,
    threadId,
    role: x.role as ChatMessageRole,
    body: (x.body as string) ?? "",
    kind: x.kind as ChatMessageKind,
    resolved: !!x.resolved,
    meta,
    created: new Date(x.created as string),
    updated: new Date(x.updated as string),
  };
}

export class PocketBaseChatBackend implements ChatBackend {
  constructor(
    private pb: () => PocketBase,
    private mirror: PBMirror,
  ) {}

  async listMessages(
    userId: string,
    opts: ListChatMessagesOptions,
  ): Promise<ChatMessage[]> {
    // threadId is required by the type signature; the runtime check is here
    // so a JS caller (no TS check) can't accidentally smuggle in undefined
    // and silently merge threads.
    if (typeof opts.threadId !== "string" || opts.threadId.length === 0) {
      throw new Error("listMessages requires opts.threadId (e.g. 'pm' or 'obs:<id>')");
    }
    const limit = opts.limit ?? 50;
    const pb = this.pb();
    const clauses = ["owner = {:uid} && thread_id = {:tid}"];
    const params: Record<string, unknown> = {
      uid: userId,
      tid: opts.threadId,
    };
    if (opts.since) {
      clauses.push("created > {:since}");
      params.since = opts.since.toISOString();
    }
    if (typeof opts.resolved === "boolean") {
      clauses.push("resolved = {:resolved}");
      params.resolved = opts.resolved;
    }
    const filter = pb.filter(clauses.join(" && "), params);
    const result = await pb
      .collection("chat_messages")
      .getList(1, limit, { filter, sort: "-created" });
    return result.items.map(messageFromRecord);
  }

  async getMessage(id: string): Promise<ChatMessage | null> {
    try {
      const r = await this.pb().collection("chat_messages").getOne(id);
      return messageFromRecord(r);
    } catch {
      // 404 (and any transient error) → null. Callers express "missing"
      // semantically; differentiating from network failure isn't worth
      // the API complexity at this layer.
      return null;
    }
  }

  async postMessage(input: PostChatMessageInput): Promise<ChatMessage> {
    if (typeof input.threadId !== "string" || input.threadId.length === 0) {
      throw new Error(
        "postMessage requires input.threadId (e.g. 'pm' or 'obs:<id>')",
      );
    }
    const kind: ChatMessageKind = input.kind ?? "chat";
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`Invalid chat message kind: ${kind}`);
    }
    const payload: Record<string, unknown> = {
      owner: input.owner,
      thread_id: input.threadId,
      role: input.role,
      body: input.body,
      kind,
      resolved: false,
    };
    if (input.meta !== undefined && input.meta !== null) {
      payload.meta = input.meta;
    }
    const r = await this.pb().collection("chat_messages").create(payload);
    return messageFromRecord(r);
  }

  async resolveMessage(id: string): Promise<ChatMessage> {
    const r = await this.pb()
      .collection("chat_messages")
      .update(id, { resolved: true });
    return messageFromRecord(r);
  }

  /**
   * Subscribe to one thread of messages via the mirror.
   *
   * Filter is server-side AND client-side: PB's realtime filter scopes the
   * SSE stream to this owner+thread (so other threads' events don't reach us
   * over the wire), and the predicate is the same constraint applied to
   * mirror's queue overlay so an optimistic write from another thread can't
   * leak through if a wpb consumer ever lands. Today's writes flow through
   * the API service (raw PB), not wpb — but keeping the predicate matched
   * to the filter keeps the slice safe under future migration to wpb (and
   * matches the invariant resync relies on; see the INVARIANT comment in
   * mirror.ts's resync path).
   *
   * Messages come back oldest-first so the timeline renders directly without
   * a client reverse. No `limit` set — chat threads are bounded by usage
   * (handful of messages per day in the steady state) and the brief defers
   * pagination explicitly; if a thread ever blows past a few hundred entries
   * a sort+limit window can be added without changing this interface.
   */
  subscribeToMessages(
    userId: string,
    opts: { threadId: string },
    onMessages: (messages: ChatMessage[]) => void,
  ): Unsubscribe {
    if (typeof opts.threadId !== "string" || opts.threadId.length === 0) {
      throw new Error(
        "subscribeToMessages requires opts.threadId (e.g. 'pm' or 'obs:<id>')",
      );
    }
    const filter = this.pb().filter(
      "owner = {:uid} && thread_id = {:tid}",
      { uid: userId, tid: opts.threadId },
    );
    const handle = this.mirror.watch(
      {
        collection: "chat_messages",
        topic: "*",
        filter,
        sort: "created",
        predicate: (r) =>
          r.owner === userId && r.thread_id === opts.threadId,
      },
      (records) => {
        onMessages(records.map(messageFromRecord));
      },
    );
    return () => handle.unsubscribe();
  }
}
