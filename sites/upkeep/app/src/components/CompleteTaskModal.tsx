import { useState, useEffect } from "react";
import { Modal, Input, message } from "antd";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { completeTask } from "../firestore";
import type { Task } from "../types";
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
`;

const Label = styled.label`
  font-weight: 500;
  color: var(--color-text-secondary);
`;

interface CompleteTaskModalProps {
  open: boolean;
  task: Task | null;
  onClose: () => void;
}

export function CompleteTaskModal({ open, task, onClose }: CompleteTaskModalProps) {
  const { user } = useAuth();
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset notes when modal opens
  useEffect(() => {
    if (open) {
      setNotes("");
    }
  }, [open]);

  const handleComplete = async () => {
    if (!task || !user) return;

    setSubmitting(true);
    try {
      await completeTask(task.id, user.uid, notes.trim());
      message.success(`"${task.name}" marked as done!`);
      onClose();
    } catch (error) {
      console.error("Failed to complete task:", error);
      message.error("Failed to mark task as done");
    } finally {
      setSubmitting(false);
    }
  };

  if (!task) return null;

  return (
    <Modal
      title="Mark Task Complete"
      open={open}
      onOk={handleComplete}
      onCancel={onClose}
      confirmLoading={submitting}
      okText="Done!"
    >
      <TaskInfo>
        <TaskName>{task.name}</TaskName>
        <TaskFrequency>{formatFrequency(task.frequency)}</TaskFrequency>
      </TaskInfo>

      <FormField>
        <Label>Notes (optional)</Label>
        <Input.TextArea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any notes about this time..."
          rows={3}
        />
      </FormField>
    </Modal>
  );
}
