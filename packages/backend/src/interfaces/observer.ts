/**
 * Observer backend interface — AI-generated reflections over life data.
 *
 * Creation is API-only (the cron / MCP endpoint creates observations on
 * behalf of the authenticated user). The frontend reads via list/get.
 */
import type { ClaudeObservation } from "../types/observer";

export interface ObserverBackend {
  /** List observations for a user, newest first. Optional limit. */
  listObservations(userId: string, limit?: number): Promise<ClaudeObservation[]>;

  /** Get a single observation by ID. */
  getObservation(id: string): Promise<ClaudeObservation>;

  /** Create a new observation. Returns the new record's ID. */
  createObservation(data: Omit<ClaudeObservation, "id" | "created">): Promise<string>;
}
