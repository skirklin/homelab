/**
 * Coach domain types — PM ↔ user chat channel (Phase C, see
 * apps/life/OBSERVER_BUILD_PLAN.md).
 *
 * Chat-shaped, owner-scoped, append-only. The "assistant" is the daily PM
 * cron in v1; a future realtime Claude Code SDK responder reads/writes the
 * same collection.
 */

export type CoachMessageRole = "assistant" | "user";

export type CoachMessageKind =
  | "chat"
  | "question"
  | "deploy_request"
  | "feedback"
  | "note";

export interface CoachMessage {
  id: string;
  owner: string;
  role: CoachMessageRole;
  /** Markdown. */
  body: string;
  kind: CoachMessageKind;
  resolved: boolean;
  /** Optional structured payload (e.g. deploy_request: { sha, files[] }). `null` when absent. */
  meta: Record<string, unknown> | null;
  created: Date;
  updated: Date;
}
