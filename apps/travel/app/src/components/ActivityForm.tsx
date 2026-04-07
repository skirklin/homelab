import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Select, Button, Space } from "antd";

const { TextArea } = Input;
import { PageContainer, useAuth } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { addActivity, updateActivity, deleteActivity, activityUpdates } from "../pocketbase";
import type { ActivityCategory, Activity } from "../types";

const CATEGORIES: ActivityCategory[] = [
  "Transportation", "Accommodation", "Hiking", "Adventure",
  "Food & Dining", "Sightseeing", "Shopping", "Nightlife",
  "Culture", "Relaxation", "Other",
];

export function ActivityForm() {
  const { tripId, activityId } = useParams<{ tripId: string; activityId: string }>();
  const navigate = useNavigate();
  const { state } = useTravelContext();
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);

  const isEdit = !!activityId;
  const existing = isEdit ? state.activities.get(activityId) : undefined;
  const [form] = Form.useForm();

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (!user || !tripId) return;
    setSaving(true);

    try {
      if (isEdit && activityId) {
        await updateActivity(activityId, activityUpdates({
          name: values.name as string,
          category: values.category as ActivityCategory,
          location: values.location as string,
          description: values.description as string,
          costNotes: values.costNotes as string,
          durationEstimate: values.durationEstimate as string,
          confirmationCode: values.confirmationCode as string,
          details: values.details as string,
          setting: values.setting as string,
        }));
        navigate(-1);
      } else {
        const now = new Date();
        await addActivity({
          name: values.name as string,
          category: (values.category as ActivityCategory) || "Other",
          location: (values.location as string) || "",
          placeId: "",
          lat: null,
          lng: null,
          description: (values.description as string) || "",
          costNotes: (values.costNotes as string) || "",
          durationEstimate: (values.durationEstimate as string) || "",
          confirmationCode: (values.confirmationCode as string) || "",
          details: (values.details as string) || "",
          setting: ((values.setting as string) || "") as Activity["setting"],
          bookingReqs: [],
          rating: null,
          ratingCount: null,
          photoRef: "",
          tripId,
          created: now,
          updated: now,
        });
        navigate(-1);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (activityId) {
      await deleteActivity(activityId);
      navigate(-1);
    }
  };

  return (
    <PageContainer>
      <h2>{isEdit ? "Edit Activity" : "New Activity"}</h2>
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={
          existing
            ? {
                name: existing.name,
                category: existing.category,
                location: existing.location,
                description: existing.description,
                costNotes: existing.costNotes,
                durationEstimate: existing.durationEstimate,
                confirmationCode: existing.confirmationCode,
                details: existing.details,
                setting: existing.setting,
              }
            : { category: "Other" }
        }
        style={{ maxWidth: 500 }}
      >
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input placeholder="e.g., Visit Fushimi Inari Shrine" />
        </Form.Item>

        <Space size="middle">
          <Form.Item name="category" label="Category">
            <Select options={CATEGORIES.map((c) => ({ label: c, value: c }))} style={{ minWidth: 150 }} />
          </Form.Item>
          <Form.Item name="setting" label="Setting">
            <Select style={{ minWidth: 100 }} options={[
              { label: "—", value: "" },
              { label: "Outdoor", value: "outdoor" },
              { label: "Indoor", value: "indoor" },
              { label: "Either", value: "either" },
            ]} />
          </Form.Item>
        </Space>

        <Form.Item name="location" label="Location">
          <Input placeholder="e.g., Kyoto" />
        </Form.Item>

        <Form.Item name="description" label="Note" extra="Brief qualifier only.">
          <Input maxLength={100} showCount placeholder="e.g., Book day of, Arrive early, Waitlist" />
        </Form.Item>

        <Form.Item name="details" label="Details" extra="What to do, what to know, logistics. Shown in day view.">
          <TextArea rows={4} placeholder="e.g., Park at the north lot. Trail starts behind the visitor center. Bring water — no facilities after the trailhead. Best views from the second overlook." />
        </Form.Item>

        <Space size="middle">
          <Form.Item name="durationEstimate" label="Duration">
            <Input placeholder="e.g., 2-3 hours" />
          </Form.Item>
          <Form.Item name="costNotes" label="Cost">
            <Input placeholder="e.g., $20 pp" />
          </Form.Item>
          <Form.Item name="confirmationCode" label="Confirmation">
            <Input placeholder="e.g., ABC123" />
          </Form.Item>
        </Space>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>
              {isEdit ? "Save" : "Add Activity"}
            </Button>
            <Button onClick={() => navigate(-1)}>Cancel</Button>
            {isEdit && (
              <Button danger onClick={handleDelete}>Delete</Button>
            )}
          </Space>
        </Form.Item>
      </Form>
    </PageContainer>
  );
}
