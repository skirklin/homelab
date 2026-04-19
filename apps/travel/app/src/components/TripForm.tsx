import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Select, DatePicker, Button, Space } from "antd";
import { PageContainer, useAuth } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { useTravelBackend } from "@kirkl/shared";
import { tripToBackend, tripUpdatesToBackend } from "../adapters";
import { STATUS_ORDER, type TripStatus } from "../types";
import dayjs from "dayjs";

const { TextArea } = Input;

export function TripForm() {
  const { tripId } = useParams<{ tripId: string }>();
  const navigate = useNavigate();
  const { state } = useTravelContext();
  const { user } = useAuth();
  const travel = useTravelBackend();
  const [saving, setSaving] = useState(false);

  const isEdit = !!tripId && tripId !== "new";
  const existingTrip = isEdit ? state.trips.get(tripId) : undefined;

  const [form] = Form.useForm();

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (!user) return;
    setSaving(true);

    try {
      const startDate = values.startDate ? (values.startDate as dayjs.Dayjs).toDate() : null;
      const endDate = values.endDate ? (values.endDate as dayjs.Dayjs).toDate() : null;

      if (isEdit && tripId) {
        await travel.updateTrip(
          tripId,
          tripUpdatesToBackend({
            destination: values.destination as string,
            status: values.status as TripStatus,
            region: values.region as string,
            startDate,
            endDate,
            notes: values.notes as string,
            sourceRefs: values.sourceRefs as string,
          })
        );
        navigate(-1);
      } else {
        const logId = state.log?.id;
        if (!logId) return;
        const now = new Date();
        const id = await travel.addTrip(
          logId,
          tripToBackend({
            destination: values.destination as string,
            status: (values.status as TripStatus) || "Idea",
            region: (values.region as string) || "",
            startDate,
            endDate,
            notes: (values.notes as string) || "",
            sourceRefs: (values.sourceRefs as string) || "",
            flaggedForReview: false,
            reviewComment: "",
            created: now,
            updated: now,
          })
        );
        navigate(`../${id}`, { replace: true });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer>
      <h2>{isEdit ? "Edit Trip" : "New Trip"}</h2>
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={
          existingTrip
            ? {
                destination: existingTrip.destination,
                status: existingTrip.status,
                region: existingTrip.region,
                startDate: existingTrip.startDate ? dayjs(existingTrip.startDate) : null,
                endDate: existingTrip.endDate ? dayjs(existingTrip.endDate) : null,
                notes: existingTrip.notes,
                sourceRefs: existingTrip.sourceRefs,
              }
            : { status: "Idea" }
        }
        style={{ maxWidth: 600 }}
      >
        <Form.Item
          name="destination"
          label="Destination"
          rules={[{ required: true, message: "Required" }]}
        >
          <Input placeholder="e.g., Tokyo, Japan" />
        </Form.Item>

        <Form.Item name="status" label="Status">
          <Select
            options={STATUS_ORDER.map((s) => ({ label: s, value: s }))}
          />
        </Form.Item>

        <Form.Item name="region" label="Region">
          <Input placeholder="e.g., Asia, Europe, Southwest US" />
        </Form.Item>

        <Space size="middle">
          <Form.Item name="startDate" label="Start Date">
            <DatePicker />
          </Form.Item>
          <Form.Item name="endDate" label="End Date">
            <DatePicker />
          </Form.Item>
        </Space>

        <Form.Item name="notes" label="Notes">
          <TextArea rows={4} />
        </Form.Item>

        <Form.Item name="sourceRefs" label="Source References">
          <TextArea
            rows={3}
            placeholder={"Gmail: booking confirmation\nCalendar: flight Mar 15\nDrive: itinerary doc"}
          />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>
              {isEdit ? "Save" : "Create Trip"}
            </Button>
            <Button onClick={() => navigate(-1)}>Cancel</Button>
          </Space>
        </Form.Item>
      </Form>
    </PageContainer>
  );
}
