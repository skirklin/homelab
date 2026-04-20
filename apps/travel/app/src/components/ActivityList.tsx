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
} from "@ant-design/icons";
import styled from "styled-components";
import { useNavigate } from "react-router-dom";
import { useTravelBackend } from "@kirkl/shared";
import { mapsUrl } from "../utils";
import type { Activity } from "../types";

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

interface ActivityListProps {
  activities: Activity[];
}

export function ActivityList({ activities }: ActivityListProps) {
  const navigate = useNavigate();
  const travel = useTravelBackend();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "";

  const sorted = useMemo(
    () => [...activities].sort((a, b) => {
      if (a.category === "Accommodation" && b.category !== "Accommodation") return -1;
      if (b.category === "Accommodation" && a.category !== "Accommodation") return 1;
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
          return (
            <Row key={a.id}>
              {a.photoRef && (
                <Photo
                  src={`https://places.googleapis.com/v1/${a.photoRef}/media?maxWidthPx=120&key=${apiKey}`}
                  alt={a.name}
                />
              )}
              <Body>
                <Name>
                  {isAccommodation && <HomeOutlined style={{ color: "#fa8c16", marginRight: 4 }} />}
                  {a.name}
                </Name>
                <Meta>
                  {a.category && (
                    <Tag color={CATEGORY_COLORS[a.category] || "default"} style={{ fontSize: 10, lineHeight: "16px", margin: 0 }}>
                      {a.category}
                    </Tag>
                  )}
                  {a.rating != null && <span style={{ color: "#fa8c16" }}>&#9733; {a.rating}</span>}
                  {a.location && (
                    url ? (
                      <ExternalLink href={url} target="_blank" rel="noopener noreferrer">
                        <EnvironmentOutlined /> {a.location}
                      </ExternalLink>
                    ) : (
                      <span><EnvironmentOutlined /> {a.location}</span>
                    )
                  )}
                  {a.durationEstimate && <span><ClockCircleOutlined /> {a.durationEstimate}</span>}
                  {a.costNotes && <span><DollarOutlined /> {a.costNotes}</span>}
                </Meta>
                {a.description && (
                  <div style={{ fontSize: 11, color: "#595959", marginTop: 3, fontStyle: "italic" }}>
                    {a.description}
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
