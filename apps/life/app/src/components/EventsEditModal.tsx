/**
 * The single event-edit surface: a modal that wraps the `EntriesList` row
 * editor around N events (1..n), each with timestamp + value editing + delete.
 * Both "edit one tapped event" (Journal / DayTimeline / a single-event calendar
 * day) and "edit a multi-event day" (HabitBoard) route through here — there is
 * no separate single-event modal.
 *
 * Deleting prunes the row from the in-modal list; when the last row goes the
 * modal closes (nothing left to edit). The caller passes the events to edit and
 * a close handler; opening is driven by passing a non-empty array.
 */
import { useEffect, useState } from "react";
import { Modal } from "antd";
import dayjs from "dayjs";
import type { LifeEvent, LifeManifestTrackable } from "@homelab/backend";
import { dayKey } from "@homelab/backend";
import { labelFor } from "../lib/shapes";
import { userTz } from "../lib/useUserTz";
import { EntriesList } from "./EntriesList";

export interface EventsEditModalProps {
  /** Events to edit; null or empty renders the modal closed. */
  events: LifeEvent[] | null;
  trackables: LifeManifestTrackable[];
  onClose: () => void;
}

/** Title: one event → "Edit · <thing> · <time>"; several → "<thing> · <day>". */
function modalTitle(events: LifeEvent[], trackables: LifeManifestTrackable[], tz: string): string {
  if (events.length === 0) return "";
  const label = labelFor(trackables, events[0].subjectId);
  if (events.length === 1) {
    return `Edit · ${label} · ${dayjs(events[0].timestamp).format("h:mm A")}`;
  }
  const [y, m, d] = dayKey(events[0].timestamp, tz).split("-").map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${label} · ${day}`;
}

export function EventsEditModal({ events, trackables, onClose }: EventsEditModalProps) {
  const tz = userTz();
  // Local copy so a delete prunes one row without re-deriving from the parent;
  // resets whenever the caller hands in a new set.
  const [rows, setRows] = useState<LifeEvent[]>(events ?? []);
  useEffect(() => {
    setRows(events ?? []);
  }, [events]);

  const open = rows.length > 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={modalTitle(rows, trackables, tz)}
      footer={null}
      destroyOnClose
      data-testid="event-edit-modal"
    >
      {open && (
        <EntriesList
          events={rows}
          emptyText={null}
          onDeleted={(id) => {
            const next = rows.filter((e) => e.id !== id);
            setRows(next);
            if (next.length === 0) onClose();
          }}
        />
      )}
    </Modal>
  );
}
