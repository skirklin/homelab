import { useState } from "react";
import styled from "styled-components";
import { Button, message } from "antd";
import { PlayCircleOutlined, PauseCircleOutlined } from "@ant-design/icons";
import { startActivity, stopActivity } from "../firestore";
import type { ActivityType, LogEntry } from "../../../shared/types";

const activityConfig: Record<ActivityType, { label: string; color: string; icon: string }> = {
  sleep: { label: "Sleep", color: "#8b5cf6", icon: "🌙" },
  gym: { label: "Gym", color: "#ef4444", icon: "💪" },
  stretch: { label: "Stretch", color: "#10b981", icon: "🧘" },
  work: { label: "Work", color: "#3b82f6", icon: "💼" },
};

const Card = styled.div<{ $color: string; $active: boolean }>`
  background: ${(props) => (props.$active ? props.$color : "var(--color-bg)")};
  border: 2px solid ${(props) => props.$color};
  border-radius: var(--radius-lg);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
  transition: all 0.2s ease;
  color: ${(props) => (props.$active ? "white" : "var(--color-text)")};
`;

const Icon = styled.div`
  font-size: 32px;
`;

const Label = styled.div`
  font-weight: 600;
  font-size: var(--font-size-md);
`;

const Duration = styled.div`
  font-size: var(--font-size-sm);
  opacity: 0.8;
`;

const ActionButton = styled(Button)<{ $active: boolean }>`
  &.ant-btn {
    background: ${(props) => (props.$active ? "rgba(255,255,255,0.2)" : "transparent")};
    border-color: ${(props) => (props.$active ? "white" : "currentColor")};
    color: inherit;

    &:hover {
      background: ${(props) => (props.$active ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.05)")};
      border-color: inherit;
      color: inherit;
    }
  }
`;

interface ActivityCardProps {
  type: ActivityType;
  activeEntry: LogEntry | undefined;
  userId: string;
  logId: string | undefined;
}

export function ActivityCard({ type, activeEntry, userId, logId }: ActivityCardProps) {
  const [loading, setLoading] = useState(false);
  const config = activityConfig[type];

  const handleToggle = async () => {
    if (!logId) return;

    setLoading(true);
    try {
      if (activeEntry) {
        await stopActivity(activeEntry.id, logId);
        message.success(`${config.label} stopped`);
      } else {
        await startActivity(type, userId, logId);
        message.success(`${config.label} started`);
      }
    } catch (error) {
      console.error("Failed to toggle activity:", error);
      message.error("Failed to update activity");
    } finally {
      setLoading(false);
    }
  };

  const formatDuration = (entry: LogEntry): string => {
    const now = new Date();
    const diffMs = now.getTime() - entry.startTime.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 60) {
      return `${diffMins}m`;
    }
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours}h ${mins}m`;
  };

  return (
    <Card $color={config.color} $active={!!activeEntry}>
      <Icon>{config.icon}</Icon>
      <Label>{config.label}</Label>
      {activeEntry && <Duration>{formatDuration(activeEntry)}</Duration>}
      <ActionButton
        $active={!!activeEntry}
        icon={activeEntry ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
        onClick={handleToggle}
        loading={loading}
        size="small"
      >
        {activeEntry ? "Stop" : "Start"}
      </ActionButton>
    </Card>
  );
}
