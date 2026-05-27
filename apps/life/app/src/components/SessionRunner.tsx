import { useState, useEffect, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Input, InputNumber, Checkbox } from "antd";
import { LeftOutlined, CheckOutlined } from "@ant-design/icons";
import { useAuth, useFeedback, PageContainer, useLifeBackend, AppHeader, useUrlParam } from "@kirkl/shared";
import type { LifeEntry } from "@homelab/backend";
import { useLifeContext } from "../life-context";
import { getSession, sessionSubjectId, type Session, type SessionPrompt } from "../manifest";
import { MorningUpkeepHeader } from "./MorningUpkeepHeader";

// sessionStorage holds the freeform answer text — they can be large and/or
// sensitive, so they don't go in the URL. The step index is in the URL
// (?step=N) so refresh + share-this-link both round-trip the wizard position.
// Key shape: `life:wizard:<sessionId>` — one slot per session kind. Starting
// the same session a second time replaces the previous draft, which is what
// you'd want ("I started morning, walked away, came back" recovers; "I did
// morning yesterday and started it again today" doesn't drag in yesterday's
// half-typed answers because the previous submit cleared the slot).
const ANSWERS_STORAGE_PREFIX = "life:wizard:";

function answersStorageKey(sessionId: Session["id"]): string {
  return `${ANSWERS_STORAGE_PREFIX}${sessionId}`;
}

function loadAnswers(sessionId: Session["id"]): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(answersStorageKey(sessionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveAnswers(sessionId: Session["id"], answers: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(answersStorageKey(sessionId), JSON.stringify(answers));
  } catch {
    // sessionStorage may be unavailable (private browsing quota, etc.) —
    // not worth surfacing; in-memory state still works for the current tab.
  }
}

function clearAnswers(sessionId: Session["id"]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(answersStorageKey(sessionId));
  } catch {
    // ignore — see saveAnswers.
  }
}

/**
 * Convert a session's accumulated answers (prompt id → value) into the
 * unified entries[] array. Prompt type drives the entry shape:
 *   text     -> { type: "text", value }
 *   rating   -> { type: "number", unit: "rating", scale: max ?? 5 }
 *   number   -> { type: "number", unit: prompt.unit ?? "ct" }
 *   checkbox -> { type: "number", value: 1|0, unit: "ct" }
 * Empty / undefined answers are skipped — the storage shape is sparse.
 */
function answersToEntries(session: Session, answers: Record<string, unknown>): LifeEntry[] {
  const out: LifeEntry[] = [];
  for (const prompt of session.prompts) {
    const v = answers[prompt.id];
    if (v === undefined || v === null || v === "") continue;
    if (prompt.type === "text" && typeof v === "string") {
      out.push({ name: prompt.id, type: "text", value: v });
    } else if (prompt.type === "rating" && typeof v === "number") {
      out.push({ name: prompt.id, type: "number", value: v, unit: "rating", scale: prompt.max ?? 5 });
    } else if (prompt.type === "number" && typeof v === "number") {
      out.push({ name: prompt.id, type: "number", value: v, unit: prompt.unit ?? "ct" });
    } else if (prompt.type === "checkbox") {
      out.push({ name: prompt.id, type: "number", value: v ? 1 : 0, unit: "ct" });
    }
  }
  return out;
}

const Greeting = styled.p`
  font-size: var(--font-size-lg);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-lg) 0;
`;

const PromptCard = styled.div`
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
`;

const PromptLabel = styled.label`
  font-size: var(--font-size-lg);
  font-weight: 500;
  color: var(--color-text);
`;

const PromptHint = styled.p`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin: 0;
`;

const Progress = styled.div`
  display: flex;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
`;

const ProgressDot = styled.span<{ $active: boolean; $done: boolean }>`
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: ${(p) => (p.$active ? "var(--color-primary)" : p.$done ? "var(--color-primary-hover)" : "var(--color-border)")};
`;

const ActionRow = styled.div`
  display: flex;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-top: var(--space-md);
`;

const RatingRow = styled.div`
  display: flex;
  gap: var(--space-sm);
`;

const RatingButton = styled.button<{ $selected: boolean }>`
  flex: 1;
  min-height: 56px;
  border-radius: var(--radius-md);
  border: 1px solid ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-bg)")};
  color: ${(p) => (p.$selected ? "white" : "var(--color-text)")};
  font-size: var(--font-size-lg);
  font-weight: 500;
  cursor: pointer;

  &:hover {
    border-color: var(--color-primary);
  }
`;

interface SessionRunnerProps {
  sessionId: Session["id"];
}

export function SessionRunner({ sessionId }: SessionRunnerProps) {
  const session = getSession(sessionId);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { state } = useLifeContext();
  const life = useLifeBackend();
  const { message } = useFeedback();
  // Step index lives in the URL (?step=N). Refresh and share-this-link both
  // round-trip the wizard position; refresh mid-wizard no longer warps back
  // to step 0. Default mode is "push" — step-advance is a drilldown, so
  // browser-back unwinds step by step. The step-zero / reset path passes
  // { mode: "replace" } per call so the cleaned URL doesn't leave a duplicate
  // history entry.
  const promptCount = session?.prompts.length ?? 0;
  const [stepIndex, setStepIndex] = useUrlParam<number>("step", {
    parse: (raw) => {
      if (!raw) return 0;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) return 0;
      if (promptCount > 0 && n >= promptCount) return promptCount - 1;
      return n;
    },
    serialize: (v) => (v <= 0 ? null : String(v)),
    default: 0,
    mode: "push",
  });
  // Answers are session-local — sensitive freeform text shouldn't ride in the
  // URL. sessionStorage is also tab-scoped so a parallel tab doing the same
  // wizard doesn't stomp each other (different tabs == different sessions).
  // Lazy-init reads any in-progress draft so a refresh restores it.
  const [answers, setAnswers] = useState<Record<string, unknown>>(() =>
    session ? loadAnswers(session.id) : {},
  );
  const [submitting, setSubmitting] = useState(false);

  // Persist any answer change to sessionStorage so refresh restores it.
  // Effect rather than inline write so React state remains the source of
  // truth in-render and storage just mirrors it.
  useEffect(() => {
    if (!session) return;
    saveAnswers(session.id, answers);
  }, [session, answers]);

  const prompt = session?.prompts[stepIndex];
  const isLast = session ? stepIndex === session.prompts.length - 1 : false;

  if (!session) {
    return (
      <PageContainer>
        <p>Unknown session: {sessionId}</p>
        <Button onClick={() => navigate("..")}>Back</Button>
      </PageContainer>
    );
  }

  const goBack = () => {
    if (stepIndex === 0) {
      // Route-relative: from `/morning` (or `/evening`, `/weekly`) this lands
      // at the parent dashboard. Survives any future re-embedding (e.g. life
      // mounted under `/life/*`) without code changes. Leave the answer draft
      // in sessionStorage so re-entering the wizard restores in-progress
      // work — only completion clears it.
      navigate("..");
    } else {
      const next = stepIndex - 1;
      // Stepping back to 0 strips the param; replace so the cleaned URL
      // doesn't leave a duplicate history entry. Otherwise fall through to
      // the hook default ("push").
      setStepIndex(next, next === 0 ? { mode: "replace" } : undefined);
    }
  };

  const setAnswer = (key: string, value: unknown) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  };

  const advance = () => {
    if (isLast) {
      submit();
    } else {
      // Default hook mode is "push" — drilldown semantics.
      setStepIndex(stepIndex + 1);
    }
  };

  const submit = async () => {
    if (!user?.uid || !state.log?.id) return;
    setSubmitting(true);
    try {
      const entries = answersToEntries(session, answers);
      await life.addEvent(
        state.log.id,
        sessionSubjectId(session.id),
        entries,
        user.uid,
        { labels: { source: "manual" } },
      );
      message.success(`${session.title} session saved`);
      // Wipe the in-progress draft now that it's been persisted to the
      // backend — re-entering the wizard starts fresh.
      clearAnswers(session.id);
      navigate("..");
    } catch (err) {
      console.error("Failed to save session:", err);
      message.error("Failed to save");
      setSubmitting(false);
    }
  };

  const canAdvance = prompt ? (prompt.optional ?? true) || answers[prompt.id] !== undefined : false;
  const skipLabel = (prompt?.optional ?? true) ? "Skip" : null;

  return (
    <>
      <AppHeader
        title={session.title}
        primaryAction={{
          label: "Back",
          icon: <LeftOutlined />,
          onClick: goBack,
        }}
      />
      <PageContainer>
        {stepIndex === 0 && <Greeting>{session.greeting}</Greeting>}
        {sessionId === "morning" && <MorningUpkeepHeader />}
        <Progress>
          {session.prompts.map((_, i) => (
            <ProgressDot key={i} $active={i === stepIndex} $done={i < stepIndex} />
          ))}
        </Progress>

        {prompt && (
          <PromptCard>
            <PromptLabel htmlFor={prompt.id}>{prompt.label}</PromptLabel>
            {prompt.hint && <PromptHint>{prompt.hint}</PromptHint>}
            <PromptInput
              prompt={prompt}
              value={answers[prompt.id]}
              onChange={(v) => setAnswer(prompt.id, v)}
            />
          </PromptCard>
        )}

        <ActionRow>
          {skipLabel ? (
            <Button onClick={advance} disabled={submitting}>
              {skipLabel}
            </Button>
          ) : <span />}
          <Button
            type="primary"
            onClick={advance}
            disabled={!canAdvance || submitting}
            loading={submitting && isLast}
            icon={isLast ? <CheckOutlined /> : undefined}
          >
            {isLast ? "Done" : "Next"}
          </Button>
        </ActionRow>
      </PageContainer>
    </>
  );
}

interface PromptInputProps {
  prompt: SessionPrompt;
  value: unknown;
  onChange: (v: unknown) => void;
}

function PromptInput({ prompt, value, onChange }: PromptInputProps) {
  switch (prompt.type) {
    case "text":
      return (
        <Input.TextArea
          id={prompt.id}
          autoFocus
          rows={3}
          placeholder={prompt.placeholder}
          value={(value as string) ?? ""}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value || undefined)}
        />
      );
    case "rating": {
      const max = prompt.max ?? 5;
      const selected = typeof value === "number" ? value : null;
      return (
        <RatingRow>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <RatingButton
              key={n}
              type="button"
              $selected={selected === n}
              onClick={() => onChange(n)}
            >
              {n}
            </RatingButton>
          ))}
        </RatingRow>
      );
    }
    case "number":
      return (
        <InputNumber
          id={prompt.id}
          autoFocus
          min={prompt.min}
          addonAfter={prompt.unit}
          value={(value as number) ?? null}
          onChange={(v) => onChange(v ?? undefined)}
          style={{ width: "100%" }}
        />
      );
    case "checkbox":
      return (
        <Checkbox
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        >
          {prompt.placeholder ?? "Yes"}
        </Checkbox>
      );
  }
}
