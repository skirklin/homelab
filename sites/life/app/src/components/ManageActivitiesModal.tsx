import { useState } from "react";
import { Modal, Button, Input, List, Popconfirm, message } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { updateActivities } from "../firestore";
import type { ActivityDef } from "../types";
import { generateActivityId } from "../types";

const ActivityItem = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-sm) 0;
`;

const ColorSwatch = styled.div<{ $color: string }>`
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: ${(props) => props.$color};
  cursor: pointer;
  border: 2px solid rgba(0, 0, 0, 0.1);
`;

const IconInput = styled(Input)`
  width: 60px;
  text-align: center;
`;

const LabelInput = styled(Input)`
  flex: 1;
`;

const ColorInput = styled.input`
  width: 60px;
  height: 32px;
  padding: 0;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  cursor: pointer;
`;

const AddButton = styled(Button)`
  margin-top: var(--space-md);
`;

interface ManageActivitiesModalProps {
  open: boolean;
  onClose: () => void;
  activities: ActivityDef[];
  logId: string | undefined;
  onActivitiesUpdated: (activities: ActivityDef[]) => void;
}

export function ManageActivitiesModal({
  open,
  onClose,
  activities,
  logId,
  onActivitiesUpdated,
}: ManageActivitiesModalProps) {
  const [localActivities, setLocalActivities] = useState<ActivityDef[]>(activities);
  const [saving, setSaving] = useState(false);

  // Reset local state when modal opens
  useState(() => {
    setLocalActivities(activities);
  });

  const handleActivityChange = (index: number, field: keyof ActivityDef, value: string) => {
    const updated = [...localActivities];
    updated[index] = { ...updated[index], [field]: value };
    setLocalActivities(updated);
  };

  const handleAddActivity = () => {
    const newActivity: ActivityDef = {
      id: generateActivityId(),
      label: "New Activity",
      icon: "📋",
      color: "#6366f1",
    };
    setLocalActivities([...localActivities, newActivity]);
  };

  const handleDeleteActivity = (index: number) => {
    const updated = localActivities.filter((_, i) => i !== index);
    setLocalActivities(updated);
  };

  const handleSave = async () => {
    if (!logId) return;

    // Validate
    const hasEmpty = localActivities.some(a => !a.label.trim() || !a.icon.trim());
    if (hasEmpty) {
      message.error("All activities must have a label and icon");
      return;
    }

    setSaving(true);
    try {
      await updateActivities(localActivities, logId);
      onActivitiesUpdated(localActivities);
      message.success("Activities updated");
      onClose();
    } catch (error) {
      console.error("Failed to update activities:", error);
      message.error("Failed to update activities");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setLocalActivities(activities);
    onClose();
  };

  return (
    <Modal
      title="Manage Activities"
      open={open}
      onCancel={handleCancel}
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          Cancel
        </Button>,
        <Button key="save" type="primary" onClick={handleSave} loading={saving}>
          Save Changes
        </Button>,
      ]}
      width={500}
    >
      <List
        dataSource={localActivities}
        renderItem={(activity, index) => (
          <ActivityItem>
            <IconInput
              value={activity.icon}
              onChange={(e) => handleActivityChange(index, "icon", e.target.value)}
              maxLength={2}
            />
            <LabelInput
              value={activity.label}
              onChange={(e) => handleActivityChange(index, "label", e.target.value)}
              placeholder="Activity name"
            />
            <ColorInput
              type="color"
              value={activity.color}
              onChange={(e) => handleActivityChange(index, "color", e.target.value)}
            />
            <Popconfirm
              title="Delete this activity?"
              description="Existing entries will show as 'Unknown'"
              onConfirm={() => handleDeleteActivity(index)}
              okText="Delete"
              cancelText="Cancel"
            >
              <Button icon={<DeleteOutlined />} danger size="small" />
            </Popconfirm>
          </ActivityItem>
        )}
      />
      <AddButton icon={<PlusOutlined />} onClick={handleAddActivity} block>
        Add Activity
      </AddButton>
    </Modal>
  );
}
