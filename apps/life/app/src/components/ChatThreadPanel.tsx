/**
 * ChatThreadPanel — reusable timeline + composer for one chat thread.
 *
 * Extracted from Chat.tsx so the PM channel (`/chat` → thread "pm") and the
 * per-observation reply threads (`/observations/:id` → thread "obs:<id>")
 * can share the exact same surface — message rendering, optimistic send,
 * "Mark resolved" affordance — while the parent route owns the page chrome
 * (AppHeader, observation card above the panel, etc.) and supplies the
 * `threadId` for this conversation.
 *
 * Reads ride a PB realtime subscription via `useChatBackend()` — the mirror's
 * first emit IS the bootstrap, so we never call `listMessages` separately
 * (this is the canonical mirror pattern, same shape shopping/life use; see
 * `packages/backend/src/wrapped-pb/mirror.ts`). Writes (post + resolve) go
 * through the API route at `/chat/messages*` using `getApiBase()` +
 * `getAuthHeaders()`. Posts pass `thread_id` so the message lands in this
 * thread.
 *
 * Out of scope (deferred per the original C2 brief): push nudge (lives in
 * the API route already), cron prompt update, real pagination.
 */
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import styled from "styled-components";
import { Button, Empty, Spin, Tag, App, Input } from "antd";
import { SendOutlined, CheckOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import ReactMarkdown from "react-markdown";
import {
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
// Mapper
// ---------------------------------------------------------------------------

// POST /chat/messages returns the raw PB record (no field renames; PB JSON
// columns parse to plain objects at the SDK layer). Mirror what the backend's
// `messageFromRecord` does so the swapped-in record is type-identical to what
// `useChatBackend().listMessages()` yields — same shape Timeline renders.
function messageFromApiRecord(raw: unknown, fallbackThreadId: string): ChatMessage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawMeta = r.meta;
  const meta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
      ? (rawMeta as Record<string, unknown>)
      : null;
  const rawThreadId = r.thread_id;
  const threadId =
    typeof rawThreadId === "string" && rawThreadId.length > 0
      ? rawThreadId
      : fallbackThreadId;
  return {
    id: String(r.id ?? ""),
    owner: String(r.owner ?? ""),
    threadId,
    role: r.role as ChatMessage["role"],
    body: (r.body as string) ?? "",
    kind: (r.kind as ChatMessageKind) ?? "chat",
    resolved: !!r.resolved,
    meta,
    created: new Date((r.created as string) ?? Date.now()),
    updated: new Date((r.updated as string) ?? Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

// The panel is a flex column that fills whatever vertical space the parent
// hands it. Timeline scrolls; composer hugs the bottom. `min-height: 0` is
// required so the inner flex children (Timeline) can actually overflow +
// scroll instead of forcing the parent to grow.
const PanelShell = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
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

// Wraps the empty placeholder when rendered INSIDE the Timeline scroll
// container (above any messages, below an optional headerSlot). Without
// this antd's <Empty> collapses against the headerSlot with no breathing
// room; the vertical padding gives it the same airy feel it had when it
// was the Section's sole child.
const EmptyWrap = styled.div`
  padding: var(--space-lg) 0;
  display: flex;
  justify-content: center;
`;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatThreadPanelProps {
  /**
   * Thread identifier to read/write. Examples: `"pm"` for the PM-iteration
   * channel, `"obs:<observation_id>"` for an observation reply thread.
   * Required — the underlying backend rejects an empty threadId so a parent
   * that forgets to pass one fails loudly rather than silently merging
   * threads.
   */
  threadId: string;
  /**
   * Empty-state copy to show when the timeline has no messages. Each
   * surface phrases this differently (the PM channel describes the cron;
   * the observation thread describes the observation), so the parent owns
   * the wording.
   */
  emptyDescription: string;
  /**
   * Optional content rendered INSIDE the Timeline scroll container, above
   * any messages and above the empty-state placeholder. Used by
   * `/observations/:id` to put the observation card in the same scroll as
   * the thread (so it scrolls out of view as the user reads replies)
   * instead of being a frozen block above the panel. When undefined the
   * panel behaves exactly as before — no extra DOM, no layout change.
   */
  headerSlot?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatThreadPanel({ threadId, emptyDescription, headerSlot }: ChatThreadPanelProps) {
  const { user } = useAuth();
  const chat = useChatBackend();
  const { message: messageApi } = App.useApp();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Reset state whenever the thread we're viewing changes — without this a
  // route swap (e.g. /observations/:id → another observation) would keep the
  // previous thread's messages visible until the new subscription's first
  // emit lands.
  useEffect(() => {
    setMessages([]);
    setLoading(true);
    setDraft("");
    setSendError(null);
  }, [threadId]);

  // Subscribe to the thread. The mirror's first emit IS the bootstrap fetch,
  // so there's no separate `listMessages` call — and no load-vs-subscribe
  // race to handle (one source of truth = one ordering).
  //
  // Merge semantics: the mirror delivers full server state (sorted oldest
  // first). We splice any unsent optimistic `temp-*` placeholders BACK ON
  // THE END so an emit that lands mid-POST doesn't drop the user's in-flight
  // message. We DROP a `temp-` placeholder if a server record in this same
  // emit carries the same (role, body, threadId) — that's the realtime echo
  // of our own POST winning the race against the POST response. The
  // post-response swap inside handleSend handles the inverse race.
  //
  // The dedup-by-content can in theory false-positive if a user posts the
  // identical body twice quickly (two temp-* in flight when the first
  // server echo lands). The cost is one of those two temps disappears for a
  // few hundred ms until the second server echo arrives — the user sees
  // their second send "land" eventually, no data loss. Acceptable given
  // (a) this is a degenerate input pattern, (b) the alternative
  // (dedup-by-tempId-on-the-server-side) requires plumbing a client-id
  // through the API, and (c) chat is owner-scoped so no cross-user
  // confusion is possible.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const unsub = chat.subscribeToMessages(
      user.uid,
      { threadId },
      (serverMessages) => {
        if (cancelled) return;
        setMessages((prev) => {
          const pendingTemps = prev.filter((m) => m.id.startsWith("temp-"));
          if (pendingTemps.length === 0) return serverMessages;
          const survivingTemps = pendingTemps.filter(
            (t) =>
              !serverMessages.some(
                (s) =>
                  s.role === t.role &&
                  s.body === t.body &&
                  s.threadId === t.threadId,
              ),
          );
          return [...serverMessages, ...survivingTemps];
        });
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [user, chat, threadId]);

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
      threadId,
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
        body: JSON.stringify({
          thread_id: threadId,
          role: "user",
          body,
          kind: "chat",
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      // Server accepted the POST and returned the canonical record. Swap the
      // optimistic placeholder in place — do NOT refetch. A refetch that
      // failed (network blip *after* the server already wrote the row) would
      // revert the optimistic insert and prompt the user to retry, producing
      // a duplicate on the server. Inline swap closes that window.
      //
      // Idempotent against the realtime echo: if the SSE event arrived first
      // and dropped the temp- by the content dedup (see the subscription
      // merge above), the temp is already gone — and a server record with
      // the canonical id is already present. We drop the temp if it's still
      // there, and we only insert the server record if it isn't present yet.
      // Either ordering converges to a single bubble with the real id.
      const created = messageFromApiRecord(await res.json(), threadId);
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        if (withoutTemp.some((m) => m.id === created.id)) return withoutTemp;
        return [...withoutTemp, created];
      });
    } catch (e) {
      // Revert the optimistic insert; surface inline error so the user can retry.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setDraft(body); // restore so the user doesn't lose what they typed
      const msg = e instanceof Error ? e.message : "Failed to send";
      setSendError(msg);
    } finally {
      setSending(false);
    }
  }, [draft, sending, user?.uid, threadId]);

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

  return (
    <PanelShell>
      {loading ? (
        <LoadingWrap>
          <Spin size="large" />
        </LoadingWrap>
      ) : (
        // Single scroll container that holds headerSlot (if any) + the
        // empty-state placeholder (if applicable) + all messages. The
        // /observations/:id surface passes its observation card as
        // headerSlot so it lives in the same scroll as the thread —
        // scrolling past the messages naturally pushes the observation
        // out the top. /chat passes no headerSlot, so the DOM is
        // identical to pre-refactor for that surface.
        <Timeline ref={timelineRef}>
          {headerSlot}
          {messages.length === 0 && (
            <EmptyWrap>
              <Empty
                description={emptyDescription}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            </EmptyWrap>
          )}
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
    </PanelShell>
  );
}
