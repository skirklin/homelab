import { useState, useEffect, useMemo, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Input, InputNumber, Checkbox } from "antd";
import { LeftOutlined, CheckOutlined } from "@ant-design/icons";
import { useAuth, useFeedback, PageContainer, useLifeBackend, AppHeader, useUrlParam } from "@kirkl/shared";
import type { LifeEntry } from "@homelab/backend";
import { useLifeContext } from "../life-context";
import { getSession, sessionSubjectId, type Session, type SessionPrompt } from "../manifest";
import { buildEntries } from "../lib/shapes";
import type { LogEvent } from "../types";
import { MorningUpkeepHeader } from "./MorningUpkeepHeader";
import { DurationFieldEditor } from "./EntryFields";

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
 * `sleep` prompts are skipped — their answer becomes a separate merged
 * `sleep` event (see sleepEntriesFromAnswer), never session-event entries.
 * Empty / undefined answers are skipped — the storage shape is sparse.
 */
function answersToEntries(session: Session, answers: Record<string, unknown>): LifeEntry[] {
  const out: LifeEntry[] = [];
  for (const prompt of session.prompts) {
    if (prompt.type === "sleep") continue;
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

// ---------- Sleep step (morning wizard) ----------
//
// The sleep step writes its OWN event: subjectId "sleep", canonical did-shape
// entries (duration + optional rating + optional notes) — ONE merged event.
// It never writes a `sleep_quality` event; quality rides as the rating entry.

const SLEEP_SUBJECT_ID = "sleep";

interface SleepAnswer {
  /** Minutes. */
  duration?: number | null;
  /** 1–5 quality, optional. */
  rating?: number | null;
  notes?: string;
}

function asSleepAnswer(v: unknown): SleepAnswer {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as SleepAnswer) : {};
}

/** Canonical merged entries for the sleep answer, or null when there's no
 *  loggable duration (buildEntries enforces the did-shape requirement). */
function sleepEntriesFromAnswer(v: unknown): LifeEntry[] | null {
  const a = asSleepAnswer(v);
  return buildEntries("did", {
    duration: typeof a.duration === "number" ? a.duration : null,
    rating: typeof a.rating === "number" ? a.rating : null,
    notes: typeof a.notes === "string" ? a.notes : "",
  });
}

/** Rating/notes entered but no duration — would silently drop on submit, so
 *  the runner blocks Next (Skip clears) until a duration is added. */
function sleepAnswerIsPartial(v: unknown): boolean {
  const a = asSleepAnswer(v);
  const hasExtras = typeof a.rating === "number" || Boolean(a.notes?.trim());
  return hasExtras && sleepEntriesFromAnswer(v) === null;
}

/**
 * YYYY-MM-DD in the browser's local timezone. Matches LifeDashboard's
 * `getDateString` — the app's convention is "user-local day," never UTC.
 */
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Pull this morning's `intention` text out of today's `morning_session`
 * event for use as dynamic context in the evening wizard. Returns null
 * when there is no morning event today or the intention prompt was skipped
 * — the caller drops any prompt whose contextKey doesn't resolve so the
 * user never sees a "you skipped this morning" placeholder.
 */
function findMorningIntention(entries: Map<string, LogEvent>): string | null {
  const today = localDayKey(new Date());
  const subject = sessionSubjectId("morning");
  for (const event of entries.values()) {
    if (event.subjectId !== subject) continue;
    if (localDayKey(event.timestamp) !== today) continue;
    for (const e of event.entries) {
      if (e.name === "intention" && e.type === "text" && e.value.trim()) {
        return e.value.trim();
      }
    }
  }
  return null;
}

/**
 * Most recent weekly_review intention, if any, within the last 8 days
 * (Sunday-night → following Sunday-night, with a small grace window so a
 * Sunday late-night or Monday early-morning review still anchors the week
 * cleanly). Used as a passive "this week:" banner above the morning prompts
 * — anchors the weekly cadence inside the daily one without adding a prompt.
 * Returns null when there's no recent weekly_review with an intention value.
 */
function findCurrentWeekIntention(entries: Map<string, LogEvent>): string | null {
  const subject = sessionSubjectId("weekly_review");
  const cutoffMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
  let bestText: string | null = null;
  let bestTs = 0;
  for (const event of entries.values()) {
    if (event.subjectId !== subject) continue;
    const ts = event.timestamp.getTime();
    if (ts < cutoffMs) continue;
    if (ts <= bestTs) continue;
    for (const e of event.entries) {
      if (e.name === "intention" && e.type === "text" && e.value.trim()) {
        bestText = e.value.trim();
        bestTs = ts;
        break;
      }
    }
  }
  return bestText;
}

/**
 * Resolve a SessionPrompt's dynamic context. Three return values, by design:
 *   - string   → substitute this into `{context}` in the hint and render
 *   - null     → contextKey was set but the lookup failed → drop the prompt
 *   - undefined → no contextKey on the prompt → render as-is, no substitution
 *
 * Keeping the three states distinct lets the runner branch cleanly: filter
 * on `=== null`, substitute on `typeof === "string"`, default otherwise.
 */
function resolveContext(prompt: SessionPrompt, ctx: SessionContext): string | null | undefined {
  if (prompt.contextKey === "morning_intention") return ctx.morningIntention;
  return undefined;
}

interface SessionContext {
  morningIntention: string | null;
}

const Greeting = styled.p`
  font-size: var(--font-size-lg);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-lg) 0;
`;

/**
 * Passive anchor shown above the morning prompts when the user has done a
 * recent weekly_review with an intention. Not a prompt — just a quiet line
 * that keeps the week's stated focus visible while answering "What matters
 * today?" Designed to fade rather than nag: italic, muted, side-rule.
 */
const WeeklyIntentionBanner = styled.p`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-md) 0;
  font-style: italic;
  border-left: 2px solid var(--color-border);
  padding: var(--space-xs) var(--space-md);
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
  //
  // Resolve dynamic context once per render — today the only entry is the
  // morning intention pulled into the evening wizard (DATA_COLLECTION.md A1).
  // Prompts whose `contextKey` doesn't resolve are filtered out, so the
  // wizard collapses from N+1 → N prompts on days the user didn't journal
  // in the morning.
  const sessionContext = useMemo<SessionContext>(() => ({
    morningIntention: findMorningIntention(state.entries),
  }), [state.entries]);

  // Passive weekly-intention anchor for the morning session. Computed
  // regardless of session id (cheap) and only rendered for morning below.
  const weeklyIntention = useMemo(
    () => findCurrentWeekIntention(state.entries),
    [state.entries],
  );

  const prompts = useMemo<SessionPrompt[]>(() => {
    if (!session) return [];
    return session.prompts.filter((p) => {
      const ctx = resolveContext(p, sessionContext);
      // undefined === "no contextKey → always render"; null === "contextKey
      // failed to resolve → drop"; string === "resolved, render with sub".
      return ctx !== null;
    });
  }, [session, sessionContext]);

  const promptCount = prompts.length;
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

  const prompt = prompts[stepIndex];
  const isLast = promptCount > 0 && stepIndex === promptCount - 1;
  // Hint rendering: substitute `{context}` for the resolved context string
  // when a prompt has a contextKey. Done at render time (not in the
  // manifest) so the static schema stays declarative.
  const resolvedHint = useMemo(() => {
    if (!prompt?.hint) return undefined;
    const ctx = resolveContext(prompt, sessionContext);
    if (typeof ctx === "string") return prompt.hint.replace("{context}", ctx);
    return prompt.hint;
  }, [prompt, sessionContext]);

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
    // Walk the filtered prompt list rather than session.prompts: a prompt
    // whose contextKey didn't resolve was never shown, so any stale answer
    // sitting in the draft for it (from a separate wizard run earlier
    // today) must not get written out.
    const entries = answersToEntries({ ...session, prompts }, answers);
    // The sleep step (morning) writes its own merged event; a partial answer
    // (rating/notes without duration) builds to null and writes nothing.
    const sleepPrompt = prompts.find((p) => p.type === "sleep");
    const sleepEntries = sleepPrompt ? sleepEntriesFromAnswer(answers[sleepPrompt.id]) : null;
    if (entries.length === 0 && !sleepEntries) {
      // UI-level guard for F1 — no-op the submit instead of writing an
      // empty-payload event. The backend will also throw if this slips
      // through, but the friendly path catches the common case (user
      // tapped through every prompt without typing anything).
      message.info("Nothing to save — add a value before finishing.");
      return;
    }
    setSubmitting(true);
    try {
      // Session event first. If the sleep write then fails, retrying the
      // submit duplicates only the session event (benign — dashboard shows
      // the latest); the reverse order would duplicate the sleep event and
      // double the day's sleep sum.
      if (entries.length > 0) {
        await life.addEvent(
          state.log.id,
          sessionSubjectId(session.id),
          entries,
          user.uid,
          { labels: { source: "manual" } },
        );
      }
      if (sleepEntries) {
        await life.addEvent(
          state.log.id,
          SLEEP_SUBJECT_ID,
          sleepEntries,
          user.uid,
          { labels: { source: "manual" } },
        );
      }
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

  // Sleep step: block Next on a partial answer (rating/notes without a
  // duration) — submitting it would silently drop what the user typed.
  const canAdvance = prompt
    ? prompt.type === "sleep"
      ? !sleepAnswerIsPartial(answers[prompt.id])
      : (prompt.optional ?? true) || answers[prompt.id] !== undefined
    : false;
  const skipLabel = (prompt?.optional ?? true) ? "Skip" : null;

  // Skip discards the sleep step's draft (so a partial answer can't linger
  // into submit); other prompt types keep theirs (re-entering restores).
  const skip = () => {
    if (prompt?.type === "sleep") setAnswer(prompt.id, undefined);
    advance();
  };

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
        {sessionId === "morning" && weeklyIntention && (
          <WeeklyIntentionBanner>This week: “{weeklyIntention}”</WeeklyIntentionBanner>
        )}
        <Progress>
          {prompts.map((_, i) => (
            <ProgressDot key={i} $active={i === stepIndex} $done={i < stepIndex} />
          ))}
        </Progress>

        {prompt && (
          <PromptCard>
            <PromptLabel htmlFor={prompt.id}>{prompt.label}</PromptLabel>
            {resolvedHint && <PromptHint>{resolvedHint}</PromptHint>}
            <PromptInput
              prompt={prompt}
              value={answers[prompt.id]}
              onChange={(v) => setAnswer(prompt.id, v)}
            />
          </PromptCard>
        )}

        <ActionRow>
          {skipLabel ? (
            <Button onClick={skip} disabled={submitting}>
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
    case "sleep": {
      const a = asSleepAnswer(value);
      const partial = sleepAnswerIsPartial(value);
      const set = (patch: Partial<SleepAnswer>) =>
        onChange({
          duration: a.duration ?? null,
          rating: a.rating ?? null,
          notes: a.notes ?? "",
          ...patch,
        });
      return (
        <SleepStack>
          <DurationFieldEditor
            label="Duration"
            minutes={a.duration ?? null}
            onChange={(minutes) => set({ duration: minutes })}
            initialUnit="hours"
            size="middle"
          />
          <div>
            <SleepFieldLabel>Quality (optional)</SleepFieldLabel>
            <RatingRow>
              {[1, 2, 3, 4, 5].map((n) => (
                <RatingButton
                  key={n}
                  type="button"
                  $selected={a.rating === n}
                  aria-label={`Quality ${n}`}
                  onClick={() => set({ rating: a.rating === n ? null : n })}
                >
                  {n}
                </RatingButton>
              ))}
            </RatingRow>
          </div>
          <Input.TextArea
            rows={2}
            placeholder="Notes (optional)"
            value={a.notes ?? ""}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => set({ notes: e.target.value })}
          />
          {partial && <SleepFieldLabel>Add a duration to log sleep — or Skip.</SleepFieldLabel>}
        </SleepStack>
      );
    }
  }
}

const SleepStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
`;

const SleepFieldLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xs);
`;
