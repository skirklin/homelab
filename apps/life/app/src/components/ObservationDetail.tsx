/**
 * /observations/:id — single observation header + per-observation reply thread.
 *
 * Replaces the old `/chat?observation=<id>` deep-link handoff. Each
 * observation gets its own chat thread (`thread_id = "obs:<id>"`); the
 * Coach SDK keys sessions per `(owner, thread_id)` so the conversation
 * about one observation never contaminates the PM channel or another
 * observation's thread.
 *
 * Layout:
 *   - Sticky observation card at the top (the thing we're discussing).
 *   - ChatThreadPanel below filling the remaining vertical space.
 *
 * Robustness:
 *   - 404 / fetch failure renders an "observation not found" placeholder.
 *     The compose box is hidden in that case — there's nothing to anchor
 *     the conversation to.
 *   - Missing/empty `:id` segment falls back to the same not-found state.
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import styled from "styled-components";
import { Empty, Spin, Tag } from "antd";
import {
  CalendarOutlined,
  BookOutlined,
  LineChartOutlined,
  MessageOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  AppHeader,
  PageContainer,
  Section,
  useObserverBackend,
} from "@kirkl/shared";
import type { ClaudeObservation } from "@homelab/backend";
import { ChatThreadPanel } from "./ChatThreadPanel";

dayjs.extend(relativeTime);

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

// Sticky 100dvh layout — same pattern as Chat.tsx so the composer hugs the
// bottom on iOS PWAs / notched devices.
const Shell = styled.div`
  display: flex;
  flex-direction: column;
  height: 100dvh;
`;

const DetailPageContainer = styled(PageContainer)`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding-bottom: 0;
`;

const ObservationCard = styled.div`
  background: var(--color-bg);
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  margin-bottom: var(--space-md);
  flex-shrink: 0;
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

const Content = styled.div`
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
`;

const LoadingWrap = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  flex: 1;
`;

// ---------------------------------------------------------------------------
// Helpers (mirrored from Observations.tsx so the badge looks consistent)
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

export function ObservationDetail() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const observer = useObserverBackend();

  const [observation, setObservation] = useState<ClaudeObservation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadObservation = useCallback(async () => {
    if (!id) {
      setLoadError("Observation not found");
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const obs = await observer.getObservation(id);
      setObservation(obs);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Observation not found");
    } finally {
      setLoading(false);
    }
  }, [id, observer]);

  useEffect(() => {
    loadObservation();
  }, [loadObservation]);

  const menuItems = [
    { key: "journal", icon: <BookOutlined />, label: "Journal", onClick: () => navigate("/journal") },
    { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate("/insights") },
    { key: "observations", icon: <RobotOutlined />, label: "Observations", onClick: () => navigate("/observations") },
    { key: "chat", icon: <MessageOutlined />, label: "Chat", onClick: () => navigate("/chat") },
  ];

  // The thread_id is the only contract that ties this page to chat — it's
  // derived once from the URL and passed straight through. If the route
  // matched with no `:id`, the loadObservation effect above flips into
  // not-found and we never render the panel anyway.
  const threadId = id ? `obs:${id}` : null;

  return (
    <Shell>
      <AppHeader
        title="Observation"
        onBack={() => navigate("/observations")}
        menuItems={menuItems}
      />

      <DetailPageContainer>
        {loading ? (
          <LoadingWrap>
            <Spin size="large" />
          </LoadingWrap>
        ) : loadError || !observation || !threadId ? (
          <Section>
            <Empty
              description={loadError ?? "Observation not found"}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </Section>
        ) : (
          <>
            <ObservationCard>
              <CardHeader>
                {periodTag(observation.period)}
                <Timestamp>
                  <CalendarOutlined />{" "}
                  {dayjs(observation.created).format("MMM D, YYYY h:mm A")}
                  {" · "}
                  {dayjs(observation.created).fromNow()}
                </Timestamp>
              </CardHeader>
              <Content>{observation.content}</Content>
            </ObservationCard>

            <ChatThreadPanel
              threadId={threadId}
              emptyDescription="No replies yet. Start a conversation about this observation — the coach will respond inline."
            />
          </>
        )}
      </DetailPageContainer>
    </Shell>
  );
}
