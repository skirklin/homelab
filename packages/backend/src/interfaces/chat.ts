/**
 * Chat backend interface — PM ↔ user chat channel (Phase C, see
 * apps/life/OBSERVER_BUILD_PLAN.md §"Phase C — PM ↔ user channel").
 * Renamed from `coach` before any deploy; user-facing name is "Chat".
 *
 * Flat chat log, owner-scoped, append-only. The v1 "assistant" is the daily
 * PM cron; a future realtime Claude Code SDK responder reads/writes the
 * same collection so the swap is additive, not a rewrite.
 *
 * Both the user (via UI / MCP) and the assistant (via cron / SDK) call into
 * this interface. The caller stamps `role` explicitly — owner is always the
 * conversation tenant (the user), regardless of speaker.
 */
import type {
  ChatMessage,
  ChatMessageKind,
  ChatMessageRole,
} from "../types/chat";

export interface ListChatMessagesOptions {
  /**
   * Which thread to read. REQUIRED — there is no default at this layer
   * because letting it default would silently merge messages across
   * threads (PM iteration + per-observation replies), reintroducing the
   * exact contamination this refactor exists to prevent. Callers pass
   * `"pm"` for the PM channel, `"obs:<observation_id>"` for an observation
   * reply thread, etc. See `ChatMessage.threadId` for the scheme.
   */
  threadId: string;
  /** Only return messages created strictly after this instant. */
  since?: Date;
  /** Page size cap. Default 50. */
  limit?: number;
  /** Filter by resolved state. Omit to include both. */
  resolved?: boolean;
}

export interface PostChatMessageInput {
  /** Conversation tenant (the user the channel belongs to). */
  owner: string;
  /**
   * Thread identifier. REQUIRED — see `ChatMessage.threadId` for the
   * scheme. Pass `"pm"`, `"obs:<id>"`, etc.
   */
  threadId: string;
  role: ChatMessageRole;
  /** Markdown. */
  body: string;
  /** Defaults to `"chat"` if omitted. */
  kind?: ChatMessageKind;
  /** Optional structured payload. */
  meta?: unknown;
}

export interface ChatBackend {
  /**
   * List messages for `userId` within a specific thread, newest-first.
   * Supports `since` (created > since) for "messages since my last tick"
   * and `resolved` for "still-open questions."
   *
   * Callers MUST pass `opts.threadId` — there is no cross-thread list at
   * this layer.
   */
  listMessages(
    userId: string,
    opts: ListChatMessagesOptions,
  ): Promise<ChatMessage[]>;

  /** Get a single message by id, or `null` if not found. */
  getMessage(id: string): Promise<ChatMessage | null>;

  /** Post a new message. Returns the created record. */
  postMessage(input: PostChatMessageInput): Promise<ChatMessage>;

  /** Flip `resolved = true`. Returns the updated record. */
  resolveMessage(id: string): Promise<ChatMessage>;
}
