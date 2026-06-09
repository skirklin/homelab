/**
 * PocketBase realtime subscription on `chat_messages`.
 *
 * Every new `role="user"` row triggers
 * `pushMessage(ownerId, threadId, body)` into the agent manager. The
 * thread id partitions the chat log into independent conversations (the
 * "pm" PM-iteration channel vs. "obs:<id>" per-observation reply
 * threads) and the agent keys SDK sessions on the `(owner, thread_id)`
 * pair so they never share transcript context. Assistant messages we
 * POST in response also flow through this collection (the existing
 * /chat/messages route writes them), but we filter on `role === "user"`
 * so our own writeback doesn't loop.
 *
 * Reconnection: the PB SDK's realtime client auto-reconnects on transport
 * failure, so the only thing we own is "subscribe once on boot, log any
 * teardown." If the SDK ever exposes a connection-event hook we can wire
 * a /health flag from it.
 */
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";

import type { AgentManager } from "./agent.js";

/** Shape of a row we care about — narrowed from RecordModel for type safety. */
interface ChatMessageRecord extends RecordModel {
  owner: string;
  thread_id: string;
  role: string;
  body: string;
}

export interface ChatSubscription {
  /** True once the initial PB `.subscribe()` resolved. /health uses this. */
  isActive: () => boolean;
  /** Unsubscribe + tear down. */
  close: () => Promise<void>;
}

/**
 * Subscribe to `chat_messages` and forward new `role="user"` rows to the
 * agent manager, keyed by the row's `(owner, thread_id)`. Returns a
 * handle so callers can shut down cleanly.
 */
export async function startChatSubscriber(
  pb: PocketBase,
  manager: AgentManager,
): Promise<ChatSubscription> {
  let active = false;

  const unsubscribe = await pb.collection("chat_messages").subscribe<ChatMessageRecord>(
    "*",
    (event) => {
      // We only want fresh user messages — `create` actions. Updates
      // (resolve toggle) and deletes have no role for the agent to play.
      if (event.action !== "create") return;
      const rec = event.record;
      if (!rec || rec.role !== "user") return;
      if (typeof rec.body !== "string" || rec.body.length === 0) return;
      if (typeof rec.owner !== "string" || rec.owner.length === 0) return;
      // Defensive: post-migration every row carries a non-empty thread_id
      // (PB enforces `required: true, min: 1`). The only way this branch
      // fires is a half-applied DB or a foreign writer that bypassed the
      // API. Log + skip rather than default-fill — defaulting to "pm" on
      // a foreign write would route an observation-thread row into the PM
      // session, the exact contamination this refactor exists to prevent.
      if (typeof rec.thread_id !== "string" || rec.thread_id.length === 0) {
        console.warn(
          `[coach] dropping chat_messages row ${rec.id} with empty thread_id`,
        );
        return;
      }

      manager
        .pushMessage(rec.owner, rec.thread_id, rec.body)
        .catch((err) =>
          console.error(
            `[coach] pushMessage failed for ${rec.owner}/${rec.thread_id}:`,
            err instanceof Error ? err.message : err,
          ),
        );
    },
  );

  active = true;

  return {
    isActive: () => active,
    async close() {
      active = false;
      try {
        await unsubscribe();
      } catch (e) {
        console.error("[coach] chat unsubscribe failed:", e);
      }
    },
  };
}
