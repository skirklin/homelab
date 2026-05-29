/**
 * Chat domain types — PM ↔ user chat channel (Phase C, see
 * apps/life/OBSERVER_BUILD_PLAN.md). Renamed from `coach` before any deploy.
 *
 * Chat-shaped, owner-scoped, append-only. The "assistant" is the daily PM
 * cron in v1; a future realtime Claude Code SDK responder reads/writes the
 * same collection.
 */

export type ChatMessageRole = "assistant" | "user";

export type ChatMessageKind =
  | "chat"
  | "question"
  | "deploy_request"
  | "feedback"
  | "note";

export interface ChatMessage {
  id: string;
  owner: string;
  role: ChatMessageRole;
  /** Markdown. */
  body: string;
  kind: ChatMessageKind;
  resolved: boolean;
  /** Optional structured payload (e.g. deploy_request: { sha, files[] }). `null` when absent. */
  meta: Record<string, unknown> | null;
  created: Date;
  updated: Date;
}
