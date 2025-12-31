import { Button, Tooltip, message } from "antd";
import { CheckOutlined, EditOutlined, BellOutlined, BellFilled } from "@ant-design/icons";
import styled from "styled-components";
import type { Task } from "../types";
import { formatDueDate } from "../types";
import { useAppContext } from "../context";
import { toggleTaskNotification } from "../firestore";
import { requestNotificationPermission, getFcmToken, isNotificationSupported } from "../messaging";

const Card = styled.div`
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  display: flex;
  align-items: center;
  gap: var(--space-xs);

  &:hover {
    border-color: var(--color-primary);
  }
`;

const TaskName = styled.span`
  font-weight: 500;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const DueInfo = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
`;

const Actions = styled.div`
  display: flex;
  gap: 2px;
`;

const IconBtn = styled(Button)<{ $active?: boolean }>`
  color: ${props => props.$active ? 'var(--color-primary)' : 'var(--color-text-muted)'};
  padding: 0 4px;
  height: 24px;
  min-width: 24px;
`;

interface TaskCardProps {
  task: Task;
  onEdit: () => void;
  onComplete: () => void;
}

export function TaskCard({ task, onEdit, onComplete }: TaskCardProps) {
  const { state } = useAppContext();
  const userId = state.authUser?.uid;
  const isNotified = userId ? task.notifyUsers.includes(userId) : false;

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
    <Card>
      <TaskName title={task.name}>{task.name}</TaskName>
      <DueInfo>{formatDueDate(task)}</DueInfo>
      <Actions>
        <Tooltip title="Mark done">
          <IconBtn type="text" icon={<CheckOutlined />} onClick={onComplete} />
        </Tooltip>
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
    </Card>
  );
}
