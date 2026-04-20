import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Form, Input, Select, Button, Space, DatePicker, Checkbox } from "antd";
import dayjs from "dayjs";

const { TextArea } = Input;
import { PageContainer, useAuth } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { useTravelBackend } from "@kirkl/shared";
import { activityToBackend, activityUpdatesToBackend } from "../adapters";
import type { ActivityCategory, Activity, FlightInfo } from "../types";

const CATEGORIES: ActivityCategory[] = [
  "Flight", "Transportation", "Accommodation", "Hiking", "Adventure",
  "Food & Dining", "Sightseeing", "Shopping", "Nightlife",
  "Culture", "Relaxation", "Other",
];

export function ActivityForm() {
  const { tripId, activityId } = useParams<{ tripId: string; activityId: string }>();
  const navigate = useNavigate();
  const { state } = useTravelContext();
  const { user } = useAuth();
  const travel = useTravelBackend();
  const [saving, setSaving] = useState(false);

  const isEdit = !!activityId;
  const existing = isEdit ? state.activities.get(activityId) : undefined;
  const [form] = Form.useForm();
  const category = Form.useWatch("category", form);
  const isFlight = category === "Flight";

  const buildFlightInfo = (values: Record<string, unknown>): FlightInfo | undefined => {
    const fi: FlightInfo = {
      airline: (values.flightAirline as string) || undefined,
      number: (values.flightNumber as string) || undefined,
      from: ((values.flightFrom as string) || "").toUpperCase() || undefined,
      to: ((values.flightTo as string) || "").toUpperCase() || undefined,
      departsAt: values.flightDeparts ? (values.flightDeparts as dayjs.Dayjs).toISOString() : undefined,
      arrivesAt: values.flightArrives ? (values.flightArrives as dayjs.Dayjs).toISOString() : undefined,
      fromIsHome: (values.flightFromIsHome as boolean) || undefined,
      toIsHome: (values.flightToIsHome as boolean) || undefined,
    };
    // Preserve pre-geocoded coords from the existing record so the user's edit
    // doesn't clobber them (the form doesn't surface lat/lng directly).
    if (existing?.flightInfo) {
      fi.fromLat = existing.flightInfo.fromLat;
      fi.fromLng = existing.flightInfo.fromLng;
      fi.toLat = existing.flightInfo.toLat;
      fi.toLng = existing.flightInfo.toLng;
    }
    const hasAny = Object.values(fi).some((v) => v !== undefined);
    return hasAny ? fi : undefined;
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    if (!user || !tripId) return;
    setSaving(true);

    try {
      const flightInfo = (values.category === "Flight") ? buildFlightInfo(values) : undefined;

      if (isEdit && activityId) {
        await travel.updateActivity(activityId, activityUpdatesToBackend({
          name: values.name as string,
          category: values.category as ActivityCategory,
          location: values.location as string,
          description: values.description as string,
          costNotes: values.costNotes as string,
          durationEstimate: values.durationEstimate as string,
          confirmationCode: values.confirmationCode as string,
          details: values.details as string,
          setting: values.setting as string,
          flightInfo,
        }));
        navigate(`../${tripId}`);
      } else {
        const logId = state.log?.id;
        if (!logId) return;
        const now = new Date();
        await travel.addActivity(
          logId,
          activityToBackend({
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
            flightInfo,
            tripId,
            created: now,
            updated: now,
          })
        );
        navigate(`../${tripId}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (activityId) {
      await travel.deleteActivity(activityId);
      navigate(`../${tripId}`);
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
                flightAirline: existing.flightInfo?.airline,
                flightNumber: existing.flightInfo?.number,
                flightFrom: existing.flightInfo?.from,
                flightTo: existing.flightInfo?.to,
                flightDeparts: existing.flightInfo?.departsAt ? dayjs(existing.flightInfo.departsAt) : undefined,
                flightArrives: existing.flightInfo?.arrivesAt ? dayjs(existing.flightInfo.arrivesAt) : undefined,
                flightFromIsHome: existing.flightInfo?.fromIsHome,
                flightToIsHome: existing.flightInfo?.toIsHome,
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

        {isFlight && (
          <div style={{ border: "1px solid #d9d9d9", borderRadius: 6, padding: 12, marginBottom: 16, background: "#fafafa" }}>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8, color: "#595959" }}>Flight details</div>
            <Space size="middle" wrap>
              <Form.Item name="flightAirline" label="Airline" style={{ marginBottom: 0 }}>
                <Input placeholder="UA" style={{ width: 80 }} />
              </Form.Item>
              <Form.Item name="flightNumber" label="Flight #" style={{ marginBottom: 0 }}>
                <Input placeholder="1234" style={{ width: 90 }} />
              </Form.Item>
              <Form.Item name="flightFrom" label="From" style={{ marginBottom: 0 }}>
                <Input placeholder="SFO" style={{ width: 70 }} maxLength={4} />
              </Form.Item>
              <Form.Item name="flightTo" label="To" style={{ marginBottom: 0 }}>
                <Input placeholder="JFK" style={{ width: 70 }} maxLength={4} />
              </Form.Item>
            </Space>
            <Space size="middle" wrap style={{ marginTop: 8 }}>
              <Form.Item name="flightDeparts" label="Departs" style={{ marginBottom: 0 }}>
                <DatePicker showTime format="YYYY-MM-DD HH:mm" />
              </Form.Item>
              <Form.Item name="flightArrives" label="Arrives" style={{ marginBottom: 0 }}>
                <DatePicker showTime format="YYYY-MM-DD HH:mm" />
              </Form.Item>
            </Space>
            <Space size="middle" wrap style={{ marginTop: 8 }}>
              <Form.Item name="flightFromIsHome" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Checkbox>Departs from home</Checkbox>
              </Form.Item>
              <Form.Item name="flightToIsHome" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Checkbox>Arrives home</Checkbox>
              </Form.Item>
            </Space>
            <div style={{ fontSize: 11, color: "#8c8c8c", marginTop: 4 }}>
              Flights with either end at home are hidden from the itinerary map.
            </div>
          </div>
        )}

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
