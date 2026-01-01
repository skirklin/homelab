import { useState, useEffect } from "react";
import { Modal, Input, message, Tabs, List, Empty, DatePicker, Switch } from "antd";
import styled from "styled-components";
import dayjs from "dayjs";
import { useAuth } from "@kirkl/shared";
import { completeTask } from "../firestore";
import { useUpkeepContext } from "../upkeep-context";
import type { Task, Completion } from "../types";
import { formatFrequency } from "../types";

const TaskInfo = styled.div`
  margin-bottom: var(--space-md);
  padding: var(--space-md);
  background: var(--color-bg-muted);
  border-radius: var(--radius-md);
`;

const TaskName = styled.div`
  font-weight: 600;
  font-size: var(--font-size-lg);
  margin-bottom: var(--space-xs);
`;

const TaskFrequency = styled.div`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`;

const FormField = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
`;

const Label = styled.label`
  font-weight: 500;
  color: var(--color-text-secondary);
`;

const DateToggleRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
`;

const DateToggleLabel = styled.span`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`;

const HistoryItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const HistoryDate = styled.div`
  font-weight: 500;
  color: var(--color-text);
`;

const HistoryNotes = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  font-style: italic;
`;

const HistoryList = styled.div`
  max-height: 300px;
  overflow-y: auto;
`;

interface CompleteTaskModalProps {
  open: boolean;
  task: Task | null;
  onClose: () => void;
}

function formatDate(date: Date): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (isToday) {
    return `Today at ${timeStr}`;
  }
  if (isYesterday) {
    return `Yesterday at ${timeStr}`;
  }
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined
  }) + ` at ${timeStr}`;
}

export function CompleteTaskModal({ open, task, onClose }: CompleteTaskModalProps) {
  const { user } = useAuth();
  const { state } = useUpkeepContext();
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState("complete");
  const [useCustomDate, setUseCustomDate] = useState(false);
  const [customDate, setCustomDate] = useState<dayjs.Dayjs | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setNotes("");
      setActiveTab("complete");
      setUseCustomDate(false);
      setCustomDate(null);
    }
  }, [open]);

  const handleComplete = async () => {
    if (!task || !user) return;

    setSubmitting(true);
    try {
      const completedAt = useCustomDate && customDate ? customDate.toDate() : undefined;
      await completeTask(task.id, user.uid, notes.trim(), completedAt);
      const dateMsg = completedAt ? ` (${formatDate(completedAt)})` : "";
      message.success(`"${task.name}" marked as done${dateMsg}!`);
      onClose();
    } catch (error) {
      console.error("Failed to complete task:", error);
      message.error("Failed to mark task as done");
    } finally {
      setSubmitting(false);
    }
  };

  if (!task) return null;

  // Get completions for this task, sorted by date (newest first)
  const taskCompletions = state.completions
    .filter(c => c.taskId === task.id)
    .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());

  const tabItems = [
    {
      key: "complete",
      label: "Complete",
      children: (
        <>
          <DateToggleRow>
            <Switch
              size="small"
              checked={useCustomDate}
              onChange={setUseCustomDate}
            />
            <DateToggleLabel>Log for a different date/time</DateToggleLabel>
          </DateToggleRow>

          {useCustomDate && (
            <FormField>
              <Label>When was this completed?</Label>
              <DatePicker
                showTime
                value={customDate}
                onChange={setCustomDate}
                format="MMM D, YYYY h:mm A"
                style={{ width: "100%" }}
                disabledDate={(current) => current && current > dayjs()}
              />
            </FormField>
          )}

          <FormField>
            <Label>Notes (optional)</Label>
            <Input.TextArea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes about this time..."
              rows={3}
            />
          </FormField>
        </>
      ),
    },
    {
      key: "history",
      label: `History (${taskCompletions.length})`,
      children: (
        <HistoryList>
          {taskCompletions.length === 0 ? (
            <Empty description="No completion history yet" />
          ) : (
            <List
              dataSource={taskCompletions}
              renderItem={(completion: Completion) => (
                <List.Item>
                  <HistoryItem>
                    <HistoryDate>{formatDate(completion.completedAt)}</HistoryDate>
                    {completion.notes && (
                      <HistoryNotes>"{completion.notes}"</HistoryNotes>
                    )}
                  </HistoryItem>
                </List.Item>
              )}
            />
          )}
        </HistoryList>
      ),
    },
  ];

  return (
    <Modal
      title="Mark Task Complete"
      open={open}
      onOk={handleComplete}
      onCancel={onClose}
      confirmLoading={submitting}
      okText="Done!"
      okButtonProps={{ disabled: activeTab !== "complete" || (useCustomDate && !customDate) }}
    >
      <TaskInfo>
        <TaskName>{task.name}</TaskName>
        <TaskFrequency>{formatFrequency(task.frequency)}</TaskFrequency>
      </TaskInfo>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
      />
    </Modal>
  );
}
