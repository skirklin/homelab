import { useState } from "react";
import styled from "styled-components";
import { Popover, Button } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import type { LogEntry } from "../../types";
import { useLifeBackend } from "../../backend-provider";

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
  entries: LogEntry[];
  logId: string | undefined;
  children: React.ReactNode;
}

export function EntriesPopover({ entries, logId, children }: EntriesPopoverProps) {
  const life = useLifeBackend();
  const [open, setOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (entryId: string) => {
    if (!logId) return;

    setDeletingId(entryId);
    try {
      await life.deleteEntry(entryId);
      // If that was the last entry, close the popover
      if (entries.length === 1) {
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

  const content = entries.length === 0 ? (
    <EmptyMessage>No entries</EmptyMessage>
  ) : (
    <EntryList>
      {entries.map((entry) => (
        <EntryRow key={entry.id}>
          <EntryTime>{formatTime(entry.timestamp)}</EntryTime>
          <DeleteButton
            type="text"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingId === entry.id}
            onClick={() => handleDelete(entry.id)}
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
