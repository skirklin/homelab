/**
 * PocketBase implementation of CoachBackend.
 *
 * No optimistic wrapper or mirror — coach messages are infrequent (a
 * handful per day), the UI reads via plain list, and the cron / SDK
 * responder writes server-side. Plain PB SDK calls suffice.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type {
  CoachBackend,
  ListCoachMessagesOptions,
  PostCoachMessageInput,
} from "../interfaces/coach";
import type {
  CoachMessage,
  CoachMessageKind,
  CoachMessageRole,
} from "../types/coach";

const VALID_KINDS: ReadonlySet<CoachMessageKind> = new Set([
  "chat",
  "question",
  "deploy_request",
  "feedback",
  "note",
]);

function messageFromRecord(r: RecordModel): CoachMessage {
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

  return {
    id: r.id,
    owner: x.owner as string,
    role: x.role as CoachMessageRole,
    body: (x.body as string) ?? "",
    kind: x.kind as CoachMessageKind,
    resolved: !!x.resolved,
    meta,
    created: new Date(x.created as string),
    updated: new Date(x.updated as string),
  };
}

export class PocketBaseCoachBackend implements CoachBackend {
  constructor(private pb: () => PocketBase) {}

  async listMessages(
    userId: string,
    opts: ListCoachMessagesOptions = {},
  ): Promise<CoachMessage[]> {
    const limit = opts.limit ?? 50;
    const pb = this.pb();
    const clauses = ["owner = {:uid}"];
    const params: Record<string, unknown> = { uid: userId };
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
      .collection("coach_messages")
      .getList(1, limit, { filter, sort: "-created" });
    return result.items.map(messageFromRecord);
  }

  async getMessage(id: string): Promise<CoachMessage | null> {
    try {
      const r = await this.pb().collection("coach_messages").getOne(id);
      return messageFromRecord(r);
    } catch {
      // 404 (and any transient error) → null. Callers express "missing"
      // semantically; differentiating from network failure isn't worth
      // the API complexity at this layer.
      return null;
    }
  }

  async postMessage(input: PostCoachMessageInput): Promise<CoachMessage> {
    const kind: CoachMessageKind = input.kind ?? "chat";
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`Invalid coach message kind: ${kind}`);
    }
    const payload: Record<string, unknown> = {
      owner: input.owner,
      role: input.role,
      body: input.body,
      kind,
      resolved: false,
    };
    if (input.meta !== undefined && input.meta !== null) {
      payload.meta = input.meta;
    }
    const r = await this.pb().collection("coach_messages").create(payload);
    return messageFromRecord(r);
  }

  async resolveMessage(id: string): Promise<CoachMessage> {
    const r = await this.pb()
      .collection("coach_messages")
      .update(id, { resolved: true });
    return messageFromRecord(r);
  }
}
