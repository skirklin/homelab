import { useState } from "react";
import { Button, Tooltip, message, Dropdown } from "antd";
import type { MenuProps } from "antd";
import { CheckOutlined, EditOutlined, BellOutlined, BellFilled, InfoCircleOutlined, DownOutlined, UpOutlined, HistoryOutlined, ClockCircleOutlined, UndoOutlined } from "@ant-design/icons";
import styled from "styled-components";
import type { Task } from "../types";
import { formatDueDate, isTaskSnoozed, formatSnoozeRemaining } from "../types";
import { useAuth } from "@kirkl/shared";
import { toggleTaskNotification, snoozeTask, unsnoozeTask } from "../firestore";
import { requestNotificationPermission, getFcmToken, isNotificationSupported } from "../messaging";

const CardWrapper = styled.div<{ $snoozed?: boolean }>`
  background: ${props => props.$snoozed ? 'var(--color-bg-subtle)' : 'var(--color-bg)'};
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  opacity: ${props => props.$snoozed ? 0.7 : 1};

  &:hover {
    border-color: var(--color-primary);
    opacity: 1;
  }
`;

const CardHeader = styled.div`
  padding: 4px 8px;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
`;

const TaskInfo = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const TaskNameRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
`;

const TaskName = styled.span`
  font-weight: 500;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const HasNotesIcon = styled(InfoCircleOutlined)`
  color: var(--color-primary);
  font-size: 12px;
  flex-shrink: 0;
`;

const DueInfo = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
`;

const SnoozeInfo = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-warning, #faad14);
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
`;

const Actions = styled.div`
  display: flex;
  gap: 2px;
  flex-shrink: 0;
`;

const IconBtn = styled(Button)<{ $active?: boolean }>`
  color: ${props => props.$active ? 'var(--color-primary)' : 'var(--color-text-muted)'};
  padding: 0 4px;
  height: 24px;
  min-width: 24px;
`;

const NotesSection = styled.div`
  padding: 8px 12px;
  background: var(--color-bg-subtle);
  border-top: 1px solid var(--color-border);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
`;

const ExpandButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 4px;
  background: var(--color-bg-subtle);
  border: none;
  border-top: 1px solid var(--color-border);
  cursor: pointer;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);

  &:hover {
    background: var(--color-border);
  }
`;

interface TaskCardProps {
  task: Task;
  onEdit: () => void;
  onComplete: () => void;
  onViewHistory: () => void;
}

export function TaskCard({ task, onEdit, onComplete, onViewHistory }: TaskCardProps) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const userId = user?.uid;
  const isNotified = userId ? task.notifyUsers.includes(userId) : false;
  const hasNotes = !!task.description?.trim();
  const snoozed = isTaskSnoozed(task);

  const handleSnooze = async (hours: number) => {
    try {
      const until = new Date(Date.now() + hours * 60 * 60 * 1000);
      await snoozeTask(task.id, until);
      const label = hours >= 24 ? `${Math.floor(hours / 24)} day${hours >= 48 ? 's' : ''}` : `${hours} hour${hours > 1 ? 's' : ''}`;
      message.success(`Snoozed for ${label}`);
    } catch (error) {
      console.error("Failed to snooze task:", error);
      message.error("Failed to snooze task");
    }
  };

  const handleUnsnooze = async () => {
    try {
      await unsnoozeTask(task.id);
      message.success("Task unsnoozed");
    } catch (error) {
      console.error("Failed to unsnooze task:", error);
      message.error("Failed to unsnooze task");
    }
  };

  const snoozeMenuItems: MenuProps["items"] = [
    { key: "1h", label: "1 hour", onClick: () => handleSnooze(1) },
    { key: "4h", label: "4 hours", onClick: () => handleSnooze(4) },
    { key: "1d", label: "1 day", onClick: () => handleSnooze(24) },
    { key: "3d", label: "3 days", onClick: () => handleSnooze(72) },
    { key: "1w", label: "1 week", onClick: () => handleSnooze(168) },
  ];

  const handleToggleNotification = async () => {
    if (!userId) return;

    if (!isNotificationSupported()) {
      message.warning("Notifications are not supported in this browser");
      return;
    }

    try {
      if (!isNotified) {
        // Enabling notifications - check permission first
        const permission = await requestNotificationPermission();
        if (permission !== "granted") {
          message.warning("Please allow notifications to receive reminders");
          return;
        }

        // Get FCM token (also saves it to Firestore)
        await getFcmToken(userId);
      }

      await toggleTaskNotification(task.id, userId, !isNotified);
      message.success(isNotified ? "Notifications disabled" : "You'll be notified when this task is due");
    } catch (error) {
      console.error("Failed to toggle notification:", error);
      message.error("Failed to update notification settings");
    }
  };

  return (
    <CardWrapper $snoozed={snoozed}>
      <CardHeader>
        <TaskInfo>
          <TaskNameRow>
            <TaskName title={task.name}>{task.name}</TaskName>
            {hasNotes && <HasNotesIcon title="Has notes" />}
          </TaskNameRow>
          {snoozed ? (
            <SnoozeInfo>
              <ClockCircleOutlined /> Snoozed for {formatSnoozeRemaining(task)}
            </SnoozeInfo>
          ) : (
            <DueInfo>{formatDueDate(task)}</DueInfo>
          )}
        </TaskInfo>
        <Actions>
          {snoozed ? (
            <Tooltip title="Unsnooze">
              <IconBtn type="text" icon={<UndoOutlined />} onClick={handleUnsnooze} />
            </Tooltip>
          ) : (
            <>
              <Tooltip title="Mark done">
                <IconBtn type="text" icon={<CheckOutlined />} onClick={onComplete} />
              </Tooltip>
              <Tooltip title="History">
                <IconBtn type="text" icon={<HistoryOutlined />} onClick={onViewHistory} />
              </Tooltip>
              <Dropdown menu={{ items: snoozeMenuItems }} trigger={["click"]}>
                <Tooltip title="Snooze">
                  <IconBtn type="text" icon={<ClockCircleOutlined />} />
                </Tooltip>
              </Dropdown>
            </>
          )}
          <Tooltip title="Edit">
            <IconBtn type="text" icon={<EditOutlined />} onClick={onEdit} />
          </Tooltip>
          <Tooltip title={isNotified ? "Disable notifications" : "Notify me"}>
            <IconBtn
              type="text"
              $active={isNotified}
              icon={isNotified ? <BellFilled /> : <BellOutlined />}
              onClick={handleToggleNotification}
            />
          </Tooltip>
        </Actions>
      </CardHeader>

      {hasNotes && (
        <>
          {expanded && <NotesSection>{task.description}</NotesSection>}
          <ExpandButton onClick={() => setExpanded(!expanded)}>
            {expanded ? (
              <>
                <UpOutlined /> Hide notes
              </>
            ) : (
              <>
                <DownOutlined /> Show notes
              </>
            )}
          </ExpandButton>
        </>
      )}
    </CardWrapper>
  );
}
