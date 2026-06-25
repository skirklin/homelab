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
 *   - One scroll container — the observation card is the `headerSlot` of
 *     `ChatThreadPanel`, so it shares the timeline's scroll context. As
 *     the reader scrolls down through replies, the observation naturally
 *     rolls out the top instead of being a frozen header. The composer
 *     stays pinned at the bottom of the panel.
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
import { Empty, Spin } from "antd";
import {
  CalendarOutlined,
  BookOutlined,
  LineChartOutlined,
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
import { periodTag } from "../lib/observations";
import { useLifeContext } from "../life-context";

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

// Rendered as `headerSlot` inside the ChatThreadPanel's Timeline — so it
// flows in the same scroll container as the reply messages. No
// `flex-shrink: 0` / `margin-bottom` needed: Timeline's `gap` handles
// spacing between this card and the first message bubble, and we
// explicitly WANT this to scroll away as the user reads replies.
const ObservationCard = styled.div`
  background: var(--color-bg);
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: var(--space-md);
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
// Component
// ---------------------------------------------------------------------------

export function ObservationDetail() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const observer = useObserverBackend();
  const { state } = useLifeContext();
  const journalEnabled = state.log?.journalEnabled ?? true;

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

  // Full-screen reply thread: the bottom tab bar is hidden here, so a small
  // menu carries the only nav. Back goes to the Coach feed (/observations);
  // these jump to the other primary destinations. /chat is intentionally
  // omitted — it's unlinked from nav app-wide.
  const menuItems = [
    // Journal is independently switchable (default on) — omit the link when off.
    ...(journalEnabled
      ? [{ key: "journal", icon: <BookOutlined />, label: "Journal", onClick: () => navigate("/journal") }]
      : []),
    { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate("/insights") },
    { key: "observations", icon: <RobotOutlined />, label: "Coach", onClick: () => navigate("/observations") },
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
          <ChatThreadPanel
            threadId={threadId}
            emptyDescription="No replies yet. Start a conversation about this observation — the coach will respond inline."
            headerSlot={
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
            }
          />
        )}
      </DetailPageContainer>
    </Shell>
  );
}
