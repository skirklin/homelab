/**
 * Coach backend interface — PM ↔ user chat channel (Phase C, see
 * apps/life/OBSERVER_BUILD_PLAN.md §"Phase C — PM ↔ user channel").
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
  CoachMessage,
  CoachMessageKind,
  CoachMessageRole,
} from "../types/coach";

export interface ListCoachMessagesOptions {
  /** Only return messages created strictly after this instant. */
  since?: Date;
  /** Page size cap. Default 50. */
  limit?: number;
  /** Filter by resolved state. Omit to include both. */
  resolved?: boolean;
}

export interface PostCoachMessageInput {
  /** Conversation tenant (the user the channel belongs to). */
  owner: string;
  role: CoachMessageRole;
  /** Markdown. */
  body: string;
  /** Defaults to `"chat"` if omitted. */
  kind?: CoachMessageKind;
  /** Optional structured payload. */
  meta?: unknown;
}

export interface CoachBackend {
  /**
   * List messages for `userId`, newest-first. Supports `since` (created > since)
   * for "messages since my last tick" and `resolved` for "still-open questions."
   */
  listMessages(
    userId: string,
    opts?: ListCoachMessagesOptions,
  ): Promise<CoachMessage[]>;

  /** Get a single message by id, or `null` if not found. */
  getMessage(id: string): Promise<CoachMessage | null>;

  /** Post a new message. Returns the created record. */
  postMessage(input: PostCoachMessageInput): Promise<CoachMessage>;

  /** Flip `resolved = true`. Returns the updated record. */
  resolveMessage(id: string): Promise<CoachMessage>;
}
