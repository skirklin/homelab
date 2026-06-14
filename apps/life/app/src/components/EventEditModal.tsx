/**
 * Single-event "Edit entry" modal — the shared edit/delete surface for a logged
 * event tapped from the Day timeline or the Journal. It wraps the existing
 * inline `EntriesList` editor around exactly ONE event, so timestamp + value
 * editing + delete all come for free (no new editing machinery).
 *
 * Closing on delete: EntriesList signals a successful delete via `onDeleted`;
 * since we render a one-element array, the only delete empties the list, so we
 * close the modal.
 */
import { Modal } from "antd";
import dayjs from "dayjs";
import type { LifeEvent, LifeManifestTrackable } from "@homelab/backend";
import { labelFor } from "../lib/shapes";
import { EntriesList } from "./EntriesList";

export interface EventEditModalProps {
  /** The event to edit; null renders the modal closed. */
  event: LifeEvent | null;
  trackables: LifeManifestTrackable[];
  onClose: () => void;
}

export function EventEditModal({ event, trackables, onClose }: EventEditModalProps) {
  const title = event
    ? `Edit · ${labelFor(trackables, event.subjectId)} · ${dayjs(event.timestamp).format("h:mm A")}`
    : "";

  return (
    <Modal
      open={event !== null}
      onCancel={onClose}
      title={title}
      footer={null}
      destroyOnClose
      data-testid="event-edit-modal"
    >
      {event && (
        <EntriesList
          events={[event]}
          emptyText={null}
          onDeleted={onClose}
        />
      )}
    </Modal>
  );
}
