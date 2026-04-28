import { useMemo } from "react";
import { Button, Tag, Typography, Empty, Popconfirm } from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  EnvironmentOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  HomeOutlined,
  SendOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import { useNavigate } from "react-router-dom";
import { useTravelBackend } from "@kirkl/shared";
import { mapsUrl } from "../utils";
import type { Activity } from "../types";
import { VerdictButtons } from "./VerdictButtons";

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
`;

const Row = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #f0f0f0;
  border-radius: 6px;
  font-size: 12px;
  &:hover { background: #fafafa; }
`;

const Body = styled.div`
  flex: 1;
  min-width: 0;
`;

const Name = styled.div`
  font-weight: 500;
  font-size: 13px;
`;

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: #8c8c8c;
  font-size: 11px;
  margin-top: 2px;
`;

const ExternalLink = styled.a`
  color: inherit;
  text-decoration: none;
  &:hover { text-decoration: underline; color: #1677ff; }
`;

const Photo = styled.img`
  width: 60px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
`;

const Actions = styled.div`
  display: flex;
  gap: 2px;
  align-self: flex-start;
  flex-shrink: 0;
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

function formatFlightTime(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

interface ActivityListProps {
  activities: Activity[];
  /** When true, render the post-experience verdict row on each activity. */
  showReflection?: boolean;
}

export function ActivityList({ activities, showReflection = false }: ActivityListProps) {
  const navigate = useNavigate();
  const travel = useTravelBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "";

  const sorted = useMemo(
    () => [...activities].sort((a, b) => {
      // Flights first (by departure time), then accommodations, then alphabetical
      const rank = (c: string) => (c === "Flight" ? 0 : c === "Accommodation" ? 1 : 2);
      const rankA = rank(a.category);
      const rankB = rank(b.category);
      if (rankA !== rankB) return rankA - rankB;
      if (rankA === 0) {
        const aT = a.flightInfo?.departsAt || "";
        const bT = b.flightInfo?.departsAt || "";
        if (aT && bT) return aT.localeCompare(bT);
      }
      return a.name.localeCompare(b.name);
    }),
    [activities],
  );

  return (
    <Container>
      <Header>
        <Typography.Text strong style={{ fontSize: 14 }}>
          Activities ({activities.length})
        </Typography.Text>
        <Button
          size="small"
          icon={<PlusOutlined />}
          onClick={() => navigate(`activities/new`)}
        >
          Add activity
        </Button>
      </Header>

      {sorted.length === 0 ? (
        <Empty
          description="No activities yet"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: 20 }}
        />
      ) : (
        sorted.map((a) => {
          const url = mapsUrl(a);
          const isAccommodation = a.category === "Accommodation";
          const isFlight = a.category === "Flight";
          const fi = a.flightInfo;
          const flightLabel = fi ? [
            fi.airline && fi.number ? `${fi.airline}${fi.number}` : (fi.airline || fi.number),
            fi.from && fi.to ? `${fi.from} → ${fi.to}` : (fi.from || fi.to),
          ].filter(Boolean).join(" · ") : "";
          return (
            <Row key={a.id}>
              {a.photoRef && !isFlight && (
                <Photo
                  src={`https://places.googleapis.com/v1/${a.photoRef}/media?maxWidthPx=120&key=${apiKey}`}
                  alt={a.name}
                />
              )}
              <Body>
                <Name>
                  {isFlight && <SendOutlined style={{ color: "#1677ff", marginRight: 4, transform: "rotate(-45deg)" }} />}
                  {isAccommodation && <HomeOutlined style={{ color: "#fa8c16", marginRight: 4 }} />}
                  {isFlight && flightLabel ? flightLabel : a.name}
                </Name>
                <Meta>
                  {a.category && (
                    <Tag color={CATEGORY_COLORS[a.category] || "default"} style={{ fontSize: 10, lineHeight: "16px", margin: 0 }}>
                      {a.category}
                    </Tag>
                  )}
                  {isFlight && fi?.departsAt && (
                    <span><ClockCircleOutlined /> {formatFlightTime(fi.departsAt)}{fi.arrivesAt ? ` → ${formatFlightTime(fi.arrivesAt)}` : ""}</span>
                  )}
                  {!isFlight && a.rating != null && <span style={{ color: "#fa8c16" }}>&#9733; {a.rating}</span>}
                  {!isFlight && a.location && (
                    url ? (
                      <ExternalLink href={url} target="_blank" rel="noopener noreferrer">
                        <EnvironmentOutlined /> {a.location}
                      </ExternalLink>
                    ) : (
                      <span><EnvironmentOutlined /> {a.location}</span>
                    )
                  )}
                  {!isFlight && a.durationEstimate && <span><ClockCircleOutlined /> {a.durationEstimate}</span>}
                  {a.costNotes && <span><DollarOutlined /> {a.costNotes}</span>}
                  {a.confirmationCode && <span>Conf: {a.confirmationCode}</span>}
                </Meta>
                {a.description && (
                  <div style={{ fontSize: 11, color: "#595959", marginTop: 3, fontStyle: "italic" }}>
                    {a.description}
                  </div>
                )}
                {showReflection && !isFlight && (
                  <div style={{ marginTop: 4 }}>
                    <VerdictButtons activityId={a.id} current={a.verdict} />
                    {a.personalNotes && (
                      <div style={{ fontSize: 11, color: "#595959", marginTop: 3 }}>
                        {a.personalNotes}
                      </div>
                    )}
                  </div>
                )}
              </Body>
              <Actions>
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => navigate(`activities/${a.id}/edit`)}
                />
                <Popconfirm title="Delete activity?" onConfirm={() => travel.deleteActivity(a.id)} okButtonProps={{ danger: true }}>
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Actions>
            </Row>
          );
        })
      )}
    </Container>
  );
}
