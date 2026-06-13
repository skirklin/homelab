/**
 * Shared "append an event + Undo toast" hook.
 *
 * Logging ALWAYS appends a new event — no affordance disappears because
 * something was already logged today. Mis-taps are recovered via the Undo
 * action on the post-log toast (this hook) or per-entry delete in the sheet.
 */
import { useCallback } from "react";
import { Button } from "antd";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import type { LifeEntry } from "@homelab/backend";

const UNDO_TOAST_SECONDS = 5;

export interface LogEventArgs {
  logId: string;
  userId: string;
  subjectId: string;
  entries: LifeEntry[];
  /** Toast text ("Logged Coffee 16 oz"). */
  label: string;
  timestamp?: Date;
  labels?: Record<string, string>;
}

export function useLogEvent(): (args: LogEventArgs) => Promise<string | null> {
  const life = useLifeBackend();
  const { message } = useFeedback();

  return useCallback(
    async ({ logId, userId, subjectId, entries, label, timestamp, labels }: LogEventArgs) => {
      try {
        const id = await life.addEvent(logId, subjectId, entries, userId, { timestamp, labels });
        const key = `logged-${id}`;
        message.open({
          key,
          type: "success",
          duration: UNDO_TOAST_SECONDS,
          content: (
            <span>
              Logged {label}
              <Button
                type="link"
                size="small"
                onClick={async () => {
                  message.destroy(key);
                  try {
                    await life.deleteEvent(id);
                  } catch (err) {
                    console.error("Undo failed:", err);
                    message.error("Undo failed");
                  }
                }}
              >
                Undo
              </Button>
            </span>
          ),
        });
        return id;
      } catch (err) {
        console.error("Failed to log:", err);
        message.error("Failed to log");
        return null;
      }
    },
    [life, message],
  );
}
