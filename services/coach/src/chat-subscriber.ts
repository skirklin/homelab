/**
 * PocketBase realtime subscription on `chat_messages`.
 *
 * Every new `role="user"` row triggers a `pushMessage(ownerId, body)` into
 * the agent manager. Assistant messages we POST in response also flow
 * through this collection (the existing /chat/messages route writes them),
 * but we filter on `role === "user"` so our own writeback doesn't loop.
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
 * agent manager. Returns a handle so callers can shut down cleanly.
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

      manager
        .pushMessage(rec.owner, rec.body)
        .catch((err) =>
          console.error(
            `[coach] pushMessage failed for ${rec.owner}:`,
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
