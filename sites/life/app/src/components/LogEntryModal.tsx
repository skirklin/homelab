import { useEffect } from "react";
import { Modal, Form, Select, DatePicker, Input, Button, message } from "antd";
import dayjs from "dayjs";
import { addEntry, updateEntry, deleteEntry } from "../firestore";
import type { ActivityDef, LogEntry } from "../types";

interface LogEntryModalProps {
  open: boolean;
  onClose: () => void;
  entry: LogEntry | null;
  defaultActivityId: string | null;
  activities: ActivityDef[];
  logId: string | undefined;
  userId: string;
}

export function LogEntryModal({
  open,
  onClose,
  entry,
  defaultActivityId,
  activities,
  logId,
  userId,
}: LogEntryModalProps) {
  const [form] = Form.useForm();
  const isEditing = !!entry;

  const activityOptions = activities.map((a) => ({
    value: a.id,
    label: `${a.icon} ${a.label}`,
  }));

  useEffect(() => {
    if (open) {
      if (entry) {
        form.setFieldsValue({
          activityId: entry.activityId,
          startTime: dayjs(entry.startTime),
          endTime: entry.endTime ? dayjs(entry.endTime) : null,
          notes: entry.notes,
        });
      } else {
        form.resetFields();
        if (defaultActivityId) {
          form.setFieldValue("activityId", defaultActivityId);
        }
        form.setFieldValue("startTime", dayjs());
      }
    }
  }, [open, entry, defaultActivityId, form]);

  const handleSubmit = async (values: {
    activityId: string;
    startTime: dayjs.Dayjs;
    endTime: dayjs.Dayjs | null;
    notes: string;
  }) => {
    if (!logId) return;

    try {
      if (isEditing) {
        await updateEntry(
          entry.id,
          {
            startTime: values.startTime.toDate(),
            endTime: values.endTime?.toDate() ?? null,
            notes: values.notes || "",
          },
          logId
        );
        message.success("Entry updated");
      } else {
        await addEntry(
          values.activityId,
          values.startTime.toDate(),
          values.endTime?.toDate() ?? null,
          values.notes || "",
          userId,
          logId
        );
        message.success("Entry added");
      }
      onClose();
    } catch (error) {
      console.error("Failed to save entry:", error);
      message.error("Failed to save entry");
    }
  };

  const handleDelete = async () => {
    if (!entry || !logId) return;

    try {
      await deleteEntry(entry.id, logId);
      message.success("Entry deleted");
      onClose();
    } catch (error) {
      console.error("Failed to delete entry:", error);
      message.error("Failed to delete entry");
    }
  };

  return (
    <Modal
      title={isEditing ? "Edit Entry" : "Add Entry"}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <Form form={form} onFinish={handleSubmit} layout="vertical">
        <Form.Item
          name="activityId"
          label="Activity"
          rules={[{ required: true, message: "Please select an activity" }]}
        >
          <Select
            options={activityOptions}
            placeholder="Select activity"
            disabled={isEditing}
          />
        </Form.Item>

        <Form.Item
          name="startTime"
          label="Start Time"
          rules={[{ required: true, message: "Please select start time" }]}
        >
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item name="endTime" label="End Time">
          <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: "100%" }} />
        </Form.Item>

        <Form.Item name="notes" label="Notes">
          <Input.TextArea rows={3} placeholder="Optional notes..." />
        </Form.Item>

        <Form.Item style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            {isEditing && (
              <Button danger onClick={handleDelete}>
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button type="primary" htmlType="submit">
              {isEditing ? "Update" : "Add"}
            </Button>
          </div>
        </Form.Item>
      </Form>
    </Modal>
  );
}
