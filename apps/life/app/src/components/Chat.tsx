/**
 * /chat — PM ↔ user chat channel (Phase C C2).
 *
 * Timeline of messages oldest-top, newest-bottom (chat-app order, not the
 * reverse-chrono observation list). Compose box pinned to the bottom;
 * Enter sends, Shift+Enter inserts a newline.
 *
 * Reads go through `useChatBackend().listMessages()` (the backend
 * abstraction); writes (post + resolve) go through the API route at
 * `/chat/messages*` using `getApiBase()` + `getAuthHeaders()` — same
 * pattern Observations.tsx uses for the adhoc-generate POST.
 *
 * Out of scope for v1 (deferred per the C2 brief): push nudge (C3), cron
 * prompt update (C4), realtime PB subscription, real pagination.
 */
import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Empty, Spin, Tag, App, Input } from "antd";
import { SendOutlined, CheckOutlined, BookOutlined, LineChartOutlined, RobotOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import ReactMarkdown from "react-markdown";
import {
  AppHeader,
  PageContainer,
  Section,
  useAuth,
  useChatBackend,
  getApiBase,
  getAuthHeaders,
} from "@kirkl/shared";
import type { ChatMessage, ChatMessageKind } from "@homelab/backend";

dayjs.extend(relativeTime);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cap the v1 fetch — pagination is out of scope. */
const LIST_LIMIT = 100;

/** Kinds for which the assistant's open messages get a "Mark resolved" button. */
const RESOLVABLE_KINDS: ReadonlySet<ChatMessageKind> = new Set([
  "question",
  "deploy_request",
]);

// ---------------------------------------------------------------------------
// Kind metadata (badge color + label) — `chat` shows no badge.
// ---------------------------------------------------------------------------

const KIND_META: Record<Exclude<ChatMessageKind, "chat">, { label: string; color: string }> = {
  question: { label: "Question", color: "orange" },
  deploy_request: { label: "Deploy", color: "purple" },
  feedback: { label: "Feedback", color: "blue" },
  note: { label: "Note", color: "default" },
};

function KindBadge({ kind }: { kind: ChatMessageKind }) {
  if (kind === "chat") return null;
  const meta = KIND_META[kind];
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

// The page itself becomes a flex column so the timeline scrolls and the
// composer sits flush at the bottom. PageContainer adds its own padding;
// we override the bottom padding to 0 so the sticky composer hugs the edge.
const ChatPageContainer = styled(PageContainer)`
  display: flex;
  flex-direction: column;
  /* Leave room for AppHeader. 64px is the desktop header; mobile may be smaller
     but this is a safe upper bound — flex layout reflows fine. */
  height: calc(100vh - 64px);
  padding-bottom: 0;
`;

const Timeline = styled.div`
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding-bottom: var(--space-md);
`;

const Row = styled.div<{ $align: "left" | "right" }>`
  display: flex;
  flex-direction: column;
  align-items: ${(p) => (p.$align === "right" ? "flex-end" : "flex-start")};
  max-width: 100%;
`;

const Bubble = styled.div<{ $role: "assistant" | "user" }>`
  background: ${(p) =>
    p.$role === "user" ? "var(--color-primary-bg, #e6f4ff)" : "var(--color-bg)"};
  border: 1px solid
    ${(p) => (p.$role === "user" ? "var(--color-primary)" : "var(--color-border-light)")};
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  max-width: min(80%, 640px);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  word-break: break-word;
  white-space: normal;

  /* Trim markdown's default vertical margins so a one-line message doesn't
     look oversized. Nested <p> margins collapse into the bubble padding. */
  & > :first-child { margin-top: 0; }
  & > :last-child { margin-bottom: 0; }
  p { margin: 0 0 var(--space-xs) 0; }
  p:last-child { margin-bottom: 0; }
  ul, ol { margin: 0 0 var(--space-xs) 0; padding-left: 1.25em; }
  code {
    background: var(--color-bg-muted);
    padding: 1px 4px;
    border-radius: var(--radius-xs);
    font-size: 0.95em;
  }
  pre {
    background: var(--color-bg-muted);
    padding: var(--space-xs) var(--space-sm);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    margin: var(--space-xs) 0;
  }
  pre code { background: transparent; padding: 0; }
`;

const Meta = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  margin-top: var(--space-xs);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const ResolveButton = styled(Button)`
  font-size: var(--font-size-xs);
  padding: 0 var(--space-xs);
  height: auto;
  min-height: 0;
  line-height: 1.6;
`;

const Composer = styled.div`
  display: flex;
  gap: var(--space-xs);
  align-items: flex-end;
  padding: var(--space-sm) 0;
  background: var(--color-bg);
  border-top: 1px solid var(--color-border-light);
  position: sticky;
  bottom: 0;
`;

const SendButton = styled(Button)`
  flex-shrink: 0;
`;

const ErrorText = styled.div`
  color: var(--color-error, #cf1322);
  font-size: var(--font-size-xs);
  margin-top: var(--space-xs);
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

export function Chat() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const chat = useChatBackend();
  const { message: messageApi } = App.useApp();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Auto-scroll the timeline to bottom on mount + whenever messages change.
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    // requestAnimationFrame so the new bubble is laid out before we scroll.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const loadMessages = useCallback(async () => {
    if (!user) return;
    setLoadError(null);
    try {
      const list = await chat.listMessages(user.uid, { limit: LIST_LIMIT });
      // Backend returns newest-first; we want oldest-first in the timeline.
      list.reverse();
      setMessages(list);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load messages");
    } finally {
      setLoading(false);
    }
  }, [user, chat]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (!loading) scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  const handleSend = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setSendError(null);

    // Optimistic placeholder — replaced by the canonical server record on success.
    const tempId = `temp-${Date.now()}`;
    const now = new Date();
    const optimistic: ChatMessage = {
      id: tempId,
      owner: user?.uid ?? "",
      role: "user",
      body,
      kind: "chat",
      resolved: false,
      meta: null,
      created: now,
      updated: now,
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");

    try {
      const res = await fetch(`${getApiBase()}/chat/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ role: "user", body, kind: "chat" }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      // Re-pull the canonical list so we drop the optimistic placeholder and
      // pick up server-assigned id + timestamps. listLimit = 100 keeps it cheap.
      await loadMessages();
    } catch (e) {
      // Revert the optimistic insert; surface inline error so the user can retry.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(body); // restore so the user doesn't lose what they typed
      const msg = e instanceof Error ? e.message : "Failed to send";
      setSendError(msg);
    } finally {
      setSending(false);
    }
  }, [draft, sending, user?.uid, loadMessages]);

  const handleResolve = useCallback(async (id: string) => {
    // Optimistic flip.
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, resolved: true } : m)),
    );
    try {
      const res = await fetch(`${getApiBase()}/chat/messages/${id}/resolve`, {
        method: "POST",
        headers: { ...getAuthHeaders() },
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      // Revert.
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, resolved: false } : m)),
      );
      messageApi.error(
        `Couldn't mark resolved: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    }
  }, [messageApi]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const menuItems = [
    { key: "journal", icon: <BookOutlined />, label: "Journal", onClick: () => navigate("/journal") },
    { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate("/insights") },
    { key: "observations", icon: <RobotOutlined />, label: "Observations", onClick: () => navigate("/observations") },
  ];

  return (
    <>
      <AppHeader title="Chat" onBack={() => navigate("/")} menuItems={menuItems} />

      <ChatPageContainer>
        {loading ? (
          <LoadingWrap>
            <Spin size="large" />
          </LoadingWrap>
        ) : loadError ? (
          <Section>
            <Empty
              description={`Couldn't load messages: ${loadError}`}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button onClick={() => { setLoading(true); loadMessages(); }}>
                Retry
              </Button>
            </Empty>
          </Section>
        ) : messages.length === 0 ? (
          <Section>
            <Empty
              description="Nothing yet — the PM agent will post deploy nudges + UX questions here after the next tick. You can also start a conversation."
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </Section>
        ) : (
          <Timeline ref={timelineRef}>
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              const align = isUser ? "right" : "left";
              const canResolve =
                !isUser && !msg.resolved && RESOLVABLE_KINDS.has(msg.kind);

              return (
                <Row key={msg.id} $align={align}>
                  <Bubble $role={msg.role}>
                    <ReactMarkdown>{msg.body}</ReactMarkdown>
                  </Bubble>
                  <Meta>
                    <KindBadge kind={msg.kind} />
                    <span title={dayjs(msg.created).format("MMM D, YYYY h:mm A")}>
                      {dayjs(msg.created).fromNow()}
                    </span>
                    {canResolve && (
                      <ResolveButton
                        type="link"
                        size="small"
                        icon={<CheckOutlined />}
                        onClick={() => handleResolve(msg.id)}
                      >
                        Mark resolved
                      </ResolveButton>
                    )}
                    {!isUser && msg.resolved && RESOLVABLE_KINDS.has(msg.kind) && (
                      <span>resolved</span>
                    )}
                  </Meta>
                </Row>
              );
            })}
          </Timeline>
        )}

        <Composer>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message…"
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={sending}
            aria-label="Message"
          />
          <SendButton
            type="primary"
            icon={<SendOutlined />}
            loading={sending}
            disabled={draft.trim().length === 0 || sending}
            onClick={handleSend}
            aria-label="Send"
          >
            Send
          </SendButton>
        </Composer>
        {sendError && <ErrorText role="alert">{sendError}</ErrorText>}
      </ChatPageContainer>
    </>
  );
}

