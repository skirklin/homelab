import { useState, useEffect } from "react";
import { Modal, Input, message, Tabs, List, Empty, DatePicker, Switch, Button, Popconfirm } from "antd";
import { EditOutlined, DeleteOutlined, SaveOutlined, CloseOutlined } from "@ant-design/icons";
import styled from "styled-components";
import dayjs from "dayjs";
import { useAuth } from "@kirkl/shared";
import { completeTask, updateCompletion, deleteCompletion } from "../firestore";
import { useUpkeepContext } from "../upkeep-context";
import type { Task, Completion } from "../types";
import { formatFrequency, getCompletionNotes } from "../types";

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
  flex: 1;
`;

const HistoryRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  width: 100%;
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

const HistoryActions = styled.div`
  display: flex;
  gap: 4px;
  flex-shrink: 0;
`;

const HistoryList = styled.div`
  max-height: 300px;
  overflow-y: auto;
`;

const EditForm = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--color-bg-subtle);
  border-radius: var(--radius-sm);
`;

const EditActions = styled.div`
  display: flex;
  gap: var(--space-xs);
  justify-content: flex-end;
`;

interface CompleteTaskModalProps {
  open: boolean;
  task: Task | null;
  onClose: () => void;
  initialTab?: "complete" | "history";
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

export function CompleteTaskModal({ open, task, onClose, initialTab = "complete" }: CompleteTaskModalProps) {
  const { user } = useAuth();
  const { state, dispatch } = useUpkeepContext();
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [useCustomDate, setUseCustomDate] = useState(false);
  const [customDate, setCustomDate] = useState<dayjs.Dayjs | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [editDate, setEditDate] = useState<dayjs.Dayjs | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      setNotes("");
      setActiveTab(initialTab);
      setUseCustomDate(false);
      setCustomDate(null);
      setEditingId(null);
    }
  }, [open, initialTab]);

  const handleStartEdit = (completion: Completion) => {
    setEditingId(completion.id);
    setEditNotes(getCompletionNotes(completion) || "");
    setEditDate(dayjs(completion.timestamp));
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditNotes("");
    setEditDate(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editDate) return;

    setSaving(true);
    try {
      await updateCompletion(editingId, {
        notes: editNotes.trim(),
        timestamp: editDate.toDate(),
      });
      // Update local state
      dispatch({
        type: "SET_COMPLETIONS",
        completions: state.completions.map(c =>
          c.id === editingId
            ? { ...c, timestamp: editDate.toDate(), data: { ...c.data, notes: editNotes.trim() || undefined } }
            : c
        ),
      });
      message.success("Updated");
      handleCancelEdit();
    } catch (error) {
      console.error("Failed to update:", error);
      message.error("Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (completionId: string) => {
    try {
      await deleteCompletion(completionId);
      // Update local state
      dispatch({
        type: "SET_COMPLETIONS",
        completions: state.completions.filter(c => c.id !== completionId),
      });
      message.success("Deleted");
    } catch (error) {
      console.error("Failed to delete:", error);
      message.error("Failed to delete");
    }
  };

  const handleComplete = async () => {
    if (!task || !user) return;

    setSubmitting(true);
    try {
      const completedAt = useCustomDate && customDate ? customDate.toDate() : undefined;
      await completeTask(task.id, user.uid, notes.trim(), {
        completedAt,
        currentLastCompleted: task.lastCompleted ?? undefined,
      });
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
    .filter(c => c.subjectId === task.id)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

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
                  {editingId === completion.id ? (
                    <EditForm>
                      <DatePicker
                        showTime
                        value={editDate}
                        onChange={setEditDate}
                        format="MMM D, YYYY h:mm A"
                        style={{ width: "100%" }}
                        disabledDate={(current) => current && current > dayjs()}
                      />
                      <Input.TextArea
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Notes (optional)"
                        rows={2}
                      />
                      <EditActions>
                        <Button
                          size="small"
                          icon={<CloseOutlined />}
                          onClick={handleCancelEdit}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="primary"
                          size="small"
                          icon={<SaveOutlined />}
                          onClick={handleSaveEdit}
                          loading={saving}
                        >
                          Save
                        </Button>
                      </EditActions>
                    </EditForm>
                  ) : (
                    <HistoryRow>
                      <HistoryItem>
                        <HistoryDate>{formatDate(completion.timestamp)}</HistoryDate>
                        {getCompletionNotes(completion) && (
                          <HistoryNotes>"{getCompletionNotes(completion)}"</HistoryNotes>
                        )}
                      </HistoryItem>
                      <HistoryActions>
                        <Button
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => handleStartEdit(completion)}
                        />
                        <Popconfirm
                          title="Delete this entry?"
                          onConfirm={() => handleDelete(completion.id)}
                          okText="Delete"
                          cancelText="Cancel"
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                          />
                        </Popconfirm>
                      </HistoryActions>
                    </HistoryRow>
                  )}
                </List.Item>
              )}
            />
          )}
        </HistoryList>
      ),
    },
  ];

  const modalTitle = activeTab === "history" ? "Task History" : "Mark Task Complete";

  return (
    <Modal
      title={modalTitle}
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
        onChange={(key) => setActiveTab(key as "complete" | "history")}
        items={tabItems}
      />
    </Modal>
  );
}
