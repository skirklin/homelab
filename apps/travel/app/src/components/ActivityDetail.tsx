/**
 * Full-page view of a single activity (`:tripId/activities/:activityId`).
 *
 * The day-view rows are intentionally terse — the long `details`, photo, and
 * post-trip reflection live here. Edit launches the existing form, threading
 * the current location through router `state` so Cancel/Save return here
 * (see ActivityForm). Delete removes the activity record entirely (distinct
 * from a day row's "remove from this day").
 */
import { useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeftOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  EnvironmentOutlined,
} from "@ant-design/icons";
import { Button, Empty, Popconfirm, Space, Spin, Tag } from "antd";
import styled from "styled-components";
import { useTravelBackend, WideContainer } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { mapsUrl } from "../utils";
import { hikeSummary } from "./ActivityList";
import { NotesThread } from "./NotesThread";

const BackLink = styled.button`
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: #8c8c8c;
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  margin-bottom: 12px;
  &:hover { color: #595959; }
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 22px;
  font-weight: 600;
`;

const Hero = styled.img`
  width: 100%;
  max-width: 480px;
  max-height: 280px;
  object-fit: cover;
  border-radius: 8px;
  margin: 12px 0;
`;

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: #595959;
  font-size: 13px;
  margin: 8px 0;
`;

const ExternalLink = styled.a`
  color: inherit;
  text-decoration: none;
  &:hover { text-decoration: underline; color: #1677ff; }
`;

const SectionLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #8c8c8c;
  margin: 16px 0 4px;
`;

const Description = styled.div`
  font-size: 14px;
  color: #262626;
  font-style: italic;
  overflow-wrap: anywhere;
`;

const Details = styled.div`
  font-size: 14px;
  color: #262626;
  white-space: pre-wrap;
  line-height: 1.5;
  overflow-wrap: anywhere;
`;

const CATEGORY_COLORS: Record<string, string> = {
  Flight: "blue",
  Transportation: "geekblue",
  Accommodation: "orange",
  Hiking: "green",
  Adventure: "magenta",
  "Food & Dining": "volcano",
  Sightseeing: "blue",
  Shopping: "purple",
  Nightlife: "red",
  Culture: "cyan",
  Relaxation: "lime",
  Other: "default",
};

export function ActivityDetail() {
  const { tripId, activityId } = useParams<{ tripId: string; activityId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { state } = useTravelContext();
  const travel = useTravelBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "";

  const activity = activityId ? state.activities.get(activityId) : undefined;
  const hikeLine = useMemo(() => (activity ? hikeSummary(activity) : null), [activity]);

  if (state.loading) {
    return (
      <WideContainer>
        <Spin size="large" style={{ display: "block", margin: "40px auto" }} />
      </WideContainer>
    );
  }

  const backToTrip = () => navigate(`../../${tripId}`, { relative: "path" });

  if (!activity) {
    return (
      <WideContainer>
        <BackLink onClick={backToTrip}>
          <ArrowLeftOutlined /> Back
        </BackLink>
        <Empty description="Activity not found" style={{ marginTop: 40 }} />
      </WideContainer>
    );
  }

  const url = mapsUrl(activity);
  const isFlight = activity.category === "Flight";

  const goEdit = () =>
    navigate(`../${activity.id}/edit`, {
      relative: "path",
      state: { from: location.pathname + location.search },
    });

  const handleDelete = async () => {
    await travel.deleteActivity(activity.id);
    backToTrip();
  };

  return (
    <WideContainer>
      <BackLink onClick={() => navigate(-1)}>
        <ArrowLeftOutlined /> Back
      </BackLink>

      <HeaderRow>
        <Title>{activity.name}</Title>
        <Space>
          <Button icon={<EditOutlined />} onClick={goEdit}>Edit</Button>
          <Popconfirm
            title="Delete this activity?"
            description="Removes it from every itinerary day too."
            onConfirm={handleDelete}
            okButtonProps={{ danger: true }}
          >
            <Button danger icon={<DeleteOutlined />}>Delete</Button>
          </Popconfirm>
        </Space>
      </HeaderRow>

      <Meta>
        {activity.category && (
          <Tag color={CATEGORY_COLORS[activity.category] || "default"} style={{ margin: 0 }}>
            {activity.category}
          </Tag>
        )}
        {activity.rating != null && <span style={{ color: "#fa8c16" }}>&#9733; {activity.rating}</span>}
        {activity.location && (
          url ? (
            <ExternalLink href={url} target="_blank" rel="noopener noreferrer">
              <EnvironmentOutlined /> {activity.location}
            </ExternalLink>
          ) : (
            <span><EnvironmentOutlined /> {activity.location}</span>
          )
        )}
        {activity.durationEstimate && <span><ClockCircleOutlined /> {activity.durationEstimate}</span>}
        {activity.costNotes && <span><DollarOutlined /> {activity.costNotes}</span>}
        {activity.confirmationCode && <span>Conf: {activity.confirmationCode}</span>}
      </Meta>

      {hikeLine && (
        <div style={{ fontSize: 14, color: "#595959", fontWeight: 500, marginBottom: 4 }}>{hikeLine}</div>
      )}

      {activity.photoRef && !isFlight && (
        <Hero
          src={`https://places.googleapis.com/v1/${activity.photoRef}/media?maxWidthPx=960&key=${apiKey}`}
          alt={activity.name}
        />
      )}

      {activity.description && (
        <>
          <SectionLabel>Note</SectionLabel>
          <Description>{activity.description}</Description>
        </>
      )}

      {activity.details && (
        <>
          <SectionLabel>Details</SectionLabel>
          <Details>{activity.details}</Details>
        </>
      )}

      {!isFlight && (
        <>
          <SectionLabel>Reflection</SectionLabel>
          <NotesThread subjectType="activity" subjectId={activity.id} showVerdict />
        </>
      )}
    </WideContainer>
  );
}
