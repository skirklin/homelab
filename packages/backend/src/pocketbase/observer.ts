/**
 * PocketBase implementation of ObserverBackend.
 *
 * No optimistic wrapper or mirror needed — observations are created by the
 * API service (cron / MCP endpoint), not interactive UI writes. The frontend
 * only reads, so plain PB SDK calls suffice.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { ObserverBackend } from "../interfaces/observer";
import type { ClaudeObservation } from "../types/observer";

function observationFromRecord(r: RecordModel): ClaudeObservation {
  return {
    id: r.id,
    content: r["content"] as string,
    period: r["period"] as ClaudeObservation["period"],
    dataWindowStart: new Date(r["data_window_start"] as string),
    dataWindowEnd: new Date(r["data_window_end"] as string),
    relatedEventIds: Array.isArray(r["related_event_ids"])
      ? (r["related_event_ids"] as string[])
      : [],
    owner: r["owner"] as string,
    promptVersion: (r["prompt_version"] as string) || "",
    created: new Date(r["created"] as string),
  };
}

export class PocketBaseObserverBackend implements ObserverBackend {
  constructor(private pb: () => PocketBase) {}

  async listObservations(
    userId: string,
    limit = 50,
  ): Promise<ClaudeObservation[]> {
    const result = await this.pb()
      .collection("claude_observations")
      .getList(1, limit, {
        filter: this.pb().filter("owner = {:uid}", { uid: userId }),
        sort: "-created",
      });
    return result.items.map(observationFromRecord);
  }

  async getObservation(id: string): Promise<ClaudeObservation> {
    const r = await this.pb()
      .collection("claude_observations")
      .getOne(id);
    return observationFromRecord(r);
  }

  async createObservation(
    data: Omit<ClaudeObservation, "id" | "created">,
  ): Promise<string> {
    const r = await this.pb()
      .collection("claude_observations")
      .create({
        content: data.content,
        period: data.period,
        data_window_start: data.dataWindowStart.toISOString(),
        data_window_end: data.dataWindowEnd.toISOString(),
        related_event_ids: data.relatedEventIds,
        owner: data.owner,
        prompt_version: data.promptVersion,
      });
    return r.id;
  }
}
