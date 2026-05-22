import { useState } from "react";
import styled from "styled-components";
import { Popover, Button } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import type { LifeEvent } from "@homelab/backend";
import { useLifeBackend } from "@kirkl/shared";

const EntryList = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  max-height: 200px;
  overflow-y: auto;
  min-width: 150px;
`;

const EntryRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-xs);
  border-radius: var(--radius-sm);

  &:hover {
    background: var(--color-bg-muted);
  }
`;

const EntryTime = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text);
`;

const DeleteButton = styled(Button)`
  padding: 2px 6px;
  height: auto;
  min-width: auto;
`;

const EmptyMessage = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  padding: var(--space-sm);
`;

interface EntriesPopoverProps {
  events: LifeEvent[];
  logId: string | undefined;
  children: React.ReactNode;
}

export function EntriesPopover({ events, logId, children }: EntriesPopoverProps) {
  const life = useLifeBackend();
  const [open, setOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (eventId: string) => {
    if (!logId) return;

    setDeletingId(eventId);
    try {
      await life.deleteEvent(eventId);
      // If that was the last event, close the popover
      if (events.length === 1) {
        setOpen(false);
      }
    } catch (error) {
      console.error("Failed to delete:", error);
    } finally {
      setDeletingId(null);
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const content = events.length === 0 ? (
    <EmptyMessage>No entries</EmptyMessage>
  ) : (
    <EntryList>
      {events.map((event) => (
        <EntryRow key={event.id}>
          <EntryTime>{formatTime(event.timestamp)}</EntryTime>
          <DeleteButton
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingId === event.id}
            onClick={() => handleDelete(event.id)}
          />
        </EntryRow>
      ))}
    </EntryList>
  );

  return (
    <Popover
      content={content}
      title="Entries"
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottom"
    >
      {children}
    </Popover>
  );
}
