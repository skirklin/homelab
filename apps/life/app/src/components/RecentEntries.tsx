import { useState } from "react";
import styled from "styled-components";
import { List, Tag, Popconfirm, Button } from "antd";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { useFeedback } from "@kirkl/shared";
import type { LogEntry, Widget, LifeManifest } from "../types";
import { getWidget, getSource, getNotes } from "../types";
import { useLifeBackend } from "../backend-provider";
import { EditEntryModal } from "./EditEntryModal";

const EntryItem = styled(List.Item)`
  &:hover {
    background: var(--color-bg-subtle);
  }
`;

const EntryContent = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-md);
  width: 100%;
`;

const EntryTime = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  min-width: 100px;
`;

const EntryData = styled.div`
  flex: 1;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ActionButtons = styled.div`
  display: flex;
  gap: 4px;
  opacity: 0;

  ${EntryItem}:hover & {
    opacity: 1;
  }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: var(--space-xl);
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border-radius: var(--radius-md);
`;

interface RecentEntriesProps {
  entries: LogEntry[];
  manifest: LifeManifest;
  logId: string | undefined;
}

export function RecentEntries({ entries, manifest, logId }: RecentEntriesProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  const [editingEntry, setEditingEntry] = useState<LogEntry | null>(null);

  const formatTime = (date: Date): string => {
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (isToday) {
      return `Today ${timeStr}`;
    }
    if (isYesterday) {
      return `Yesterday ${timeStr}`;
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" }) + ` ${timeStr}`;
  };

  const formatData = (entry: LogEntry, widget: Widget | undefined): string => {
    if (!widget) {
      return "";
    }

    switch (widget.type) {
      case "counter":
        return "";
      case "number": {
        const value = entry.data.value as number;
        const unit = widget.unit ? ` ${widget.unit}` : "";
        return `${value}${unit}`;
      }
      case "rating": {
        const rating = entry.data.rating as number;
        return "★".repeat(rating) + "☆".repeat(widget.max - rating);
      }
      case "text":
        return entry.data.text as string;
      case "combo": {
        const parts: string[] = [];
        for (const field of widget.fields) {
          const fieldValue = entry.data[field.id];
          if (fieldValue !== undefined && fieldValue !== null && fieldValue !== "") {
            if (field.type === "rating") {
              parts.push(`${field.label}: ${"★".repeat(fieldValue as number)}`);
            } else if (field.type === "number" && field.unit) {
              parts.push(`${field.label}: ${fieldValue}${field.unit}`);
            } else {
              parts.push(`${field.label}: ${fieldValue}`);
            }
          }
        }
        return parts.join(" · ");
      }
      default:
        return "";
    }
  };

  const handleDelete = async (entry: LogEntry) => {
    if (!logId) return;
    try {
      await life.deleteEntry(entry.id);
      message.success("Entry deleted");
    } catch (error) {
      console.error("Failed to delete:", error);
      message.error("Failed to delete");
    }
  };

  if (entries.length === 0) {
    return <EmptyState>No entries yet. Start tracking!</EmptyState>;
  }

  return (
    <>
    <List
      dataSource={entries}
      renderItem={(entry) => {
        const widget = getWidget(manifest, entry.subjectId);
        const label = widget?.label ?? (entry.subjectId === "__sample__" ? "Sample Response" : "Unknown");
        const isSample = getSource(entry) === "sample";
        const notes = getNotes(entry);

        return (
          <EntryItem>
            <EntryContent>
              <Tag color={isSample ? "purple" : "blue"}>
                {label}
              </Tag>
              <EntryTime>{formatTime(entry.timestamp)}</EntryTime>
              <EntryData>{formatData(entry, widget)}</EntryData>
              {notes && (
                <EntryData style={{ fontStyle: "italic" }}>{notes}</EntryData>
              )}
              <ActionButtons>
                <Button
                  icon={<EditOutlined />}
                  size="small"
                  type="text"
                  onClick={() => setEditingEntry(entry)}
                />
                <Popconfirm
                  title="Delete this entry?"
                  onConfirm={() => handleDelete(entry)}
                  okText="Delete"
                  cancelText="Cancel"
                >
                  <Button
                    icon={<DeleteOutlined />}
                    danger
                    size="small"
                    type="text"
                  />
                </Popconfirm>
              </ActionButtons>
            </EntryContent>
          </EntryItem>
        );
      }}
    />

    <EditEntryModal
      open={editingEntry !== null}
      onClose={() => setEditingEntry(null)}
      entry={editingEntry}
      manifest={manifest}
      logId={logId}
    />
  </>
  );
}
