import { useState, useEffect } from "react";
import { Modal, Input, InputNumber, Select, Button, message } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { addTask, updateTask, deleteTask } from "../pocketbase";
import type { Task, Frequency, FrequencyUnit } from "../types";

const Form = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
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

const FrequencyRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const FrequencyLabel = styled.span`
  color: var(--color-text);
`;

const DangerZone = styled.div`
  margin-top: var(--space-lg);
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
`;

interface TaskModalProps {
  open: boolean;
  task: Task | null;
  onClose: () => void;
}

export function TaskModal({ open, task, onClose }: TaskModalProps) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [frequencyValue, setFrequencyValue] = useState(1);
  const [frequencyUnit, setFrequencyUnit] = useState<FrequencyUnit>("weeks");
  const [submitting, setSubmitting] = useState(false);

  const isEditing = !!task;

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      if (task) {
        setName(task.name);
        setDescription(task.description);
        setFrequencyValue(task.frequency.value);
        setFrequencyUnit(task.frequency.unit);
      } else {
        setName("");
        setDescription("");
        setFrequencyValue(1);
        setFrequencyUnit("weeks");
      }
    }
  }, [open, task]);

  const handleSubmit = async () => {
    if (!name.trim() || !user) return;

    const frequency: Frequency = {
      value: frequencyValue,
      unit: frequencyUnit,
    };

    setSubmitting(true);
    try {
      if (isEditing && task) {
        await updateTask(task.id, {
          name: name.trim(),
          description: description.trim(),
          frequency,
        });
        message.success("Task updated");
      } else {
        const now = new Date();
        await addTask({
          name: name.trim(),
          description: description.trim(),
          roomId: "general",
          frequency,
          lastCompleted: null,
          snoozedUntil: null,
          notifyUsers: [],
          createdBy: user.uid,
          createdAt: now,
          updatedAt: now,
        });
        message.success("Task added");
      }
      onClose();
    } catch (error) {
      console.error("Failed to save task:", error);
      message.error("Failed to save task");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;

    if (!confirm(`Delete "${task.name}"? This cannot be undone.`)) return;

    setSubmitting(true);
    try {
      await deleteTask(task.id);
      message.success("Task deleted");
      onClose();
    } catch (error) {
      console.error("Failed to delete task:", error);
      message.error("Failed to delete task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={isEditing ? "Edit Task" : "Add Task"}
      open={open}
      onOk={handleSubmit}
      onCancel={onClose}
      confirmLoading={submitting}
      okText={isEditing ? "Save" : "Add"}
      okButtonProps={{ disabled: !name.trim() }}
    >
      <Form>
        <FormField>
          <Label>Task Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Wash bedding"
            autoFocus
          />
        </FormField>

        <FormField>
          <Label>Description (optional)</Label>
          <Input.TextArea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Instructions or notes..."
            rows={2}
          />
        </FormField>

        <FormField>
          <Label>Frequency</Label>
          <FrequencyRow>
            <FrequencyLabel>Every</FrequencyLabel>
            <InputNumber
              min={1}
              max={365}
              value={frequencyValue}
              onChange={(value) => setFrequencyValue(value || 1)}
              style={{ width: 80 }}
            />
            <Select
              value={frequencyUnit}
              onChange={setFrequencyUnit}
              style={{ width: 100 }}
              options={[
                { value: "days", label: "days" },
                { value: "weeks", label: "weeks" },
                { value: "months", label: "months" },
              ]}
            />
          </FrequencyRow>
        </FormField>

        {isEditing && (
          <DangerZone>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleDelete}
              loading={submitting}
            >
              Delete Task
            </Button>
          </DangerZone>
        )}
      </Form>
    </Modal>
  );
}
