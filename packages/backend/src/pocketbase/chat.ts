/**
 * PocketBase implementation of ChatBackend. Renamed from `coach` before any
 * deploy; user-facing name is "Chat".
 *
 * No optimistic wrapper or mirror — chat messages are infrequent (a
 * handful per day), the UI reads via plain list, and the cron / SDK
 * responder writes server-side. Plain PB SDK calls suffice.
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

const VALID_KINDS: ReadonlySet<ChatMessageKind> = new Set([
  "chat",
  "question",
  "deploy_request",
  "feedback",
  "note",
]);

function messageFromRecord(r: RecordModel): ChatMessage {
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
  constructor(private pb: () => PocketBase) {}

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
}
