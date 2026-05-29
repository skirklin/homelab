/**
 * /observations — reverse-chronological list of AI-generated observations.
 *
 * Each observation is collapsed by default (first ~100 chars), click to expand.
 * "Ask Claude" button triggers an adhoc generation via the API.
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Empty, Spin, Tag, App } from "antd";
import { RobotOutlined, CalendarOutlined, BookOutlined, LineChartOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  AppHeader,
  PageContainer,
  Section,
  useAuth,
  useObserverBackend,
  getApiBase,
  getAuthHeaders,
} from "@kirkl/shared";
import type { ClaudeObservation } from "@homelab/backend";

dayjs.extend(relativeTime);

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const ObservationCard = styled.div<{ $expanded: boolean }>`
  background: var(--color-bg);
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;

  &:hover {
    border-color: var(--color-border);
    box-shadow: var(--shadow-sm);
  }

  & + & {
    margin-top: var(--space-sm);
  }
`;

const CardHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-xs);
  flex-wrap: wrap;
`;

const Timestamp = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const Content = styled.div<{ $expanded: boolean }>`
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;

  ${(p) =>
    !p.$expanded &&
    `
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  `}
`;

const GenerateRow = styled.div`
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-lg);
`;

const LoadingWrap = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PERIOD_LABELS: Record<string, { label: string; color: string }> = {
  weekly: { label: "Weekly", color: "blue" },
  monthly: { label: "Monthly", color: "purple" },
  adhoc: { label: "On-demand", color: "cyan" },
};

function periodTag(period: string) {
  const info = PERIOD_LABELS[period] ?? { label: period, color: "default" };
  return <Tag color={info.color}>{info.label}</Tag>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Observations() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const observer = useObserverBackend();
  const { message } = App.useApp();

  const [observations, setObservations] = useState<ClaudeObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadObservations = useCallback(async () => {
    if (!user) return;
    try {
      const list = await observer.listObservations(user.uid);
      setObservations(list);
    } catch {
      // Swallow — empty list is fine for initial load
    } finally {
      setLoading(false);
    }
  }, [user, observer]);

  useEffect(() => {
    loadObservations();
  }, [loadObservations]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const now = new Date();
      const windowStart = new Date(now);
      windowStart.setDate(windowStart.getDate() - 14);

      const res = await fetch(`${getApiBase()}/observer/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          period: "adhoc",
          window_start: windowStart.toISOString(),
          window_end: now.toISOString(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      // Refetch so the new observation appears at the top
      setLoading(true);
      await loadObservations();
      message.success("Observation generated");
    } catch (err) {
      message.error(
        `Failed to generate observation: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      setGenerating(false);
    }
  };

  const menuItems = [
    { key: "journal", icon: <BookOutlined />, label: "Journal", onClick: () => navigate("/journal") },
    { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate("/insights") },
  ];

  return (
    <>
      <AppHeader
        title="Observations"
        onBack={() => navigate("/")}
        menuItems={menuItems}
      />

      <PageContainer>
        <GenerateRow>
          <Button
            type="primary"
            icon={<RobotOutlined />}
            loading={generating}
            onClick={handleGenerate}
            size="large"
          >
            Ask Claude about the last 2 weeks
          </Button>
        </GenerateRow>

        {loading ? (
          <LoadingWrap>
            <Spin size="large" />
          </LoadingWrap>
        ) : observations.length === 0 ? (
          <Section>
            <Empty
              description="No observations yet. Ask Claude to take a look at your recent data."
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </Section>
        ) : (
          <List>
            {observations.map((obs) => {
              const expanded = expandedId === obs.id;
              return (
                <ObservationCard
                  key={obs.id}
                  $expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : obs.id)}
                >
                  <CardHeader>
                    {periodTag(obs.period)}
                    <Timestamp>
                      <CalendarOutlined />{" "}
                      {dayjs(obs.created).format("MMM D, YYYY h:mm A")}
                      {" \u00b7 "}
                      {dayjs(obs.created).fromNow()}
                    </Timestamp>
                  </CardHeader>
                  <Content $expanded={expanded}>{obs.content}</Content>
                </ObservationCard>
              );
            })}
          </List>
        )}
      </PageContainer>
    </>
  );
}
