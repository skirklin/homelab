import styled from "styled-components";
import { List, Tag } from "antd";
import { EditOutlined } from "@ant-design/icons";
import type { ActivityDef, LogEntry } from "../types";
import { getActivity } from "../types";

const EntryItem = styled(List.Item)`
  cursor: pointer;

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
  min-width: 140px;
`;

const EntryDuration = styled.div`
  font-weight: 500;
  min-width: 60px;
`;

const EntryNotes = styled.div`
  flex: 1;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const EditIcon = styled(EditOutlined)`
  color: var(--color-text-secondary);
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
  activities: ActivityDef[];
  onEdit: (entry: LogEntry) => void;
}

export function RecentEntries({ entries, activities, onEdit }: RecentEntriesProps) {
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

  const formatDuration = (entry: LogEntry): string => {
    if (entry.duration === null) {
      return "In progress";
    }
    if (entry.duration < 60) {
      return `${entry.duration}m`;
    }
    const hours = Math.floor(entry.duration / 60);
    const mins = entry.duration % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  };

  if (entries.length === 0) {
    return <EmptyState>No entries yet. Start tracking!</EmptyState>;
  }

  return (
    <List
      dataSource={entries}
      renderItem={(entry) => {
        const activity = getActivity(activities, entry.activityId);
        const label = activity?.label ?? "Unknown";
        // Convert hex color to antd tag color name (approximate)
        const tagColor = activity?.color ?? "#888";
        return (
          <EntryItem onClick={() => onEdit(entry)}>
            <EntryContent>
              <Tag style={{ background: tagColor, color: "white", border: "none" }}>
                {activity?.icon} {label}
              </Tag>
              <EntryTime>{formatTime(entry.startTime)}</EntryTime>
              <EntryDuration>{formatDuration(entry)}</EntryDuration>
              <EntryNotes>{entry.notes}</EntryNotes>
              <EditIcon />
            </EntryContent>
          </EntryItem>
        );
      }}
    />
  );
}
