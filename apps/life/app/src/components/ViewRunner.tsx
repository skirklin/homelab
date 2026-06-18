/**
 * Data-driven guided ViewRunner — the Phase-B2 replacement for SessionRunner on
 * the INPUT side. Given a `viewId`, it resolves a `LifeView` from `useViews()`
 * and renders its `items` as a guided wizard reproducing today's morning /
 * evening / weekly session UX (greeting, step dots, back/next, sessionStorage
 * draft, `?step=` URL param).
 *
 * ── BYTE-IDENTICAL WRITE (the load-bearing B2 contract) ─────────────────────
 * Even though the View references the NEW split vocab ids (`daily_intention`,
 * `daily_win`, `weekly_lesson`, …), a completed run still writes EXACTLY the fat
 * `*_session` event today's SessionRunner writes:
 *
 *     addEvent(logId, "<viewId>_session", entries, uid, { labels: { source: "manual" } })
 *
 * where `entries` is keyed by the ORIGINAL prompt ids (`gratitude`, `intention`,
 * `energy`, `win`, `lesson`, …) with the same type/unit/scale `answersToEntries`
 * produced. The vocab-id → legacy-entry-name translation happens ONLY in the
 * write path, via `LEGACY_ENTRY_NAME` below. This is what makes B2 fully
 * reversible: every reader (Journal, DayTimeline, SessionStreakGrid, the Coach
 * bundle.ts) stays untouched because the on-disk shape is unchanged. The
 * per-item event split is Phase B3, NOT here.
 */
import { useState, useEffect, useMemo, type ChangeEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Input } from "antd";
import { LeftOutlined, CheckOutlined, SunOutlined, MoonOutlined, CalendarOutlined } from "@ant-design/icons";
import {
  useAuth,
  useFeedback,
  PageContainer,
  useLifeBackend,
  AppHeader,
  useUrlParam,
} from "@kirkl/shared";
import type { LifeEntry, LifeView, LifeViewItem, LifeManifestTrackable } from "@homelab/backend";
import { useLifeContext } from "../life-context";
import { useViews } from "../lib/views";
import { useTrackables } from "../lib/trackables";
import { DEFAULT_VIEW_TRACKABLES } from "@homelab/backend";
import { resolveTemplate } from "../lib/templating";
import { userTz } from "../lib/useUserTz";
import type { LogEvent } from "../types";
import { TasksDueBlock } from "./TasksDueBlock";

// ──────────────────────────────────────────────────────────────────────────
// TRANSITIONAL (B3-REMOVABLE): new vocab id → legacy fat-event entry name.
//
// Used ONLY in the byte-identical write path. The View references the new split
// vocab ids (which give each prompt its own subject_id series in B3), but the
// fat `*_session` event TODAY is keyed by the original prompt ids. This map is
// the inverse of the design §3 id table, verified entry-by-entry against
// `SESSIONS` in apps/life/app/src/manifest.ts:
//
//   morning:  gratitude→gratitude, daily_intention→intention, energy→energy
//   evening:  intention_followup→intention_followup, daily_win→win, daily_lesson→lesson
//   weekly:   highlights→highlights, lows→lows, weekly_lesson→lesson, weekly_intention→intention
//
// Keyed PER VIEW because the new ids are globally distinct but the legacy names
// collide across sessions (morning.intention vs weekly.intention; evening.lesson
// vs weekly.lesson). DELETE this constant when B3 flips the write path to
// per-item events keyed by the vocab id directly.
const LEGACY_ENTRY_NAME: Record<string, Record<string, string>> = {
  morning: {
    gratitude: "gratitude",
    daily_intention: "intention",
    energy: "energy",
  },
  evening: {
    intention_followup: "intention_followup",
    daily_win: "win",
    daily_lesson: "lesson",
  },
  weekly: {
    highlights: "highlights",
    lows: "lows",
    weekly_lesson: "lesson",
    weekly_intention: "intention",
  },
};

// TRANSITIONAL (B3-REMOVABLE): View id → the fat-event subject_id the readers
// expect. CRITICAL for byte-identity: morning/evening view ids equal the old
// session ids, so `<id>_session` is unchanged — BUT the weekly View's id is
// `weekly` (chosen so labels.view is stable across the B3 cutover) while the
// historical session subject is `weekly_review_session` (the session id was
// `weekly_review`). Writing `weekly_session` would orphan the event from every
// reader (SessionStreakGrid/Journal/DayTimeline all key on
// `sessionSubjectId("weekly_review")`). So the weekly View maps explicitly to
// the legacy subject. Verified against `sessionSubjectId` in manifest.ts:
//   morning → morning_session, evening → evening_session,
//   weekly  → weekly_review_session.
// DELETE in B3, when the write path stops emitting fat `*_session` events.
const LEGACY_SESSION_SUBJECT: Record<string, string> = {
  morning: "morning_session",
  evening: "evening_session",
  weekly: "weekly_review_session",
};

// TRANSITIONAL (B3-REMOVABLE): the inverse of LEGACY_ENTRY_NAME, indexed by the
// legacy fat-event subject_id, mapping legacy entry name → new vocab id. Used by
// `synthesizeViewEvents` to make today's fat `*_session` history resolvable by
// templating refs that point at the NEW split vocab ids (e.g. evening's `{plan}`
// ref → `daily_intention`). Without this, B2 has NO events under those vocab ids
// (they aren't materialized until B3), so the evening follow-up and the week
// banner would ALWAYS drop — a parity regression. DELETE in B3 (real per-item
// events under the new ids make the synthesis unnecessary).
const FAT_SUBJECT_TO_VOCAB: Record<string, Record<string, string>> = {
  morning_session: { gratitude: "gratitude", intention: "daily_intention", energy: "energy" },
  evening_session: { intention_followup: "intention_followup", win: "daily_win", lesson: "daily_lesson" },
  weekly_review_session: { highlights: "highlights", lows: "lows", lesson: "weekly_lesson", intention: "weekly_intention" },
};

/**
 * TRANSITIONAL (B3-REMOVABLE): project today's fat `*_session` events into
 * synthetic per-vocab events keyed by the NEW split vocab ids, so templating
 * refs (which point at the new ids) resolve against real B2 history. One
 * synthetic event per (fat event, mapped entry), carrying just that entry with
 * the same timestamp. Returns the originals PLUS the synthetics (templating only
 * reads by subject_id, so the extras are inert for non-matching refs).
 *
 * Pure. In B3, real per-item events live under the new ids and this is deleted.
 */
export function synthesizeViewEvents(events: LogEvent[]): LogEvent[] {
  const synthetic: LogEvent[] = [];
  for (const ev of events) {
    const map = FAT_SUBJECT_TO_VOCAB[ev.subjectId];
    if (!map) continue;
    for (const entry of ev.entries) {
      const vocabId = map[entry.name];
      if (!vocabId) continue;
      synthetic.push({
        ...ev,
        id: `${ev.id}::${vocabId}`,
        subjectId: vocabId,
        entries: [entry],
      });
    }
  }
  return synthetic.length > 0 ? [...events, ...synthetic] : events;
}

const VIEW_ICONS: Record<string, ReactNode> = {
  sun: <SunOutlined />,
  moon: <MoonOutlined />,
  calendar: <CalendarOutlined />,
};

// ──────────────────────────────────────────────────────────────────────────
// Draft storage — sessionStorage, keyed by viewId. Identical scheme to the old
// SessionRunner: freeform answers are sensitive + large so they never ride in
// the URL; only the step index does (?step=N). Starting the same View again
// replaces the previous draft; a completed submit clears it.
const ANSWERS_STORAGE_PREFIX = "life:wizard:";

function answersStorageKey(viewId: string): string {
  return `${ANSWERS_STORAGE_PREFIX}${viewId}`;
}

function loadAnswers(viewId: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(answersStorageKey(viewId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveAnswers(viewId: string, answers: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(answersStorageKey(viewId), JSON.stringify(answers));
  } catch {
    // sessionStorage may be unavailable (private browsing quota, etc.).
  }
}

function clearAnswers(viewId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(answersStorageKey(viewId));
  } catch {
    // ignore — see saveAnswers.
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Resolved step model. The renderer walks `view.items`, resolving each into a
// concrete capture step (or dropping it) + a list of lead blocks. `capture`
// steps carry the resolved vocab row + filled prompt/hint text;
// `tasks_due`/`banner` are lead blocks rendered above the first step.
interface CaptureStep {
  kind: "capture";
  trackable: LifeManifestTrackable;
  optional: boolean;
  prompt: string;
  hint?: string;
}
interface TasksDueStep {
  kind: "tasks_due";
}
interface BannerStep {
  kind: "banner";
  text: string;
}
type LeadBlock = TasksDueStep | BannerStep;

/**
 * Build the legacy fat-event entries from the wizard's collected answers.
 *
 * Walks the captured vocab ids that actually appeared (the filtered step list),
 * maps each to its legacy entry name (per the view), and emits the SAME
 * type/unit/scale the old `answersToEntries` did:
 *   noted (text) → { name: legacy, type: "text",   value }
 *   rated        → { name: legacy, type: "number", value, unit: "rating", scale: 5 }
 *   (took/did/happened are not used by any default session, but are mapped
 *    canonically for completeness if a custom View ever references them.)
 * Sparse: empty / undefined answers are skipped (matches the old path).
 */
function buildFatEntries(
  viewId: string,
  captureSteps: CaptureStep[],
  answers: Record<string, unknown>,
): LifeEntry[] {
  const nameMap = LEGACY_ENTRY_NAME[viewId] ?? {};
  const out: LifeEntry[] = [];
  for (const step of captureSteps) {
    const vocabId = step.trackable.id;
    // For a default View, the legacy name comes from the map; for a custom View
    // referencing an unmapped vocab id, fall back to the vocab id itself.
    const name = nameMap[vocabId] ?? vocabId;
    const v = answers[vocabId];
    if (v === undefined || v === null || v === "") continue;
    switch (step.trackable.shape) {
      case "noted":
        if (typeof v === "string") out.push({ name, type: "text", value: v });
        break;
      case "rated":
        if (typeof v === "number") {
          out.push({ name, type: "number", value: v, unit: "rating", scale: 5 });
        }
        break;
      case "took":
        if (typeof v === "number") {
          out.push({ name, type: "number", value: v, unit: step.trackable.defaultUnit || "ct" });
        }
        break;
      case "did":
        if (typeof v === "number") {
          out.push({ name, type: "number", value: v, unit: "min" });
        }
        break;
      case "happened":
        out.push({ name, type: "number", value: 1, unit: "ct" });
        break;
    }
  }
  return out;
}

const Greeting = styled.p`
  font-size: var(--font-size-lg);
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-lg) 0;
`;

const Banner = styled.p`
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

interface ViewRunnerProps {
  viewId: string;
}

export function ViewRunner({ viewId }: ViewRunnerProps) {
  const views = useViews();
  const view = useMemo<LifeView | undefined>(() => views.find((v) => v.id === viewId), [views, viewId]);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { state } = useLifeContext();
  const life = useLifeBackend();
  const { message } = useFeedback();

  // Vocab resolution: the user's manifest trackables ∪ DEFAULT_VIEW_TRACKABLES,
  // with DEFAULT_VIEW_TRACKABLES applied LAST so it WINS on an id collision.
  //
  // B2-correct: the morning/evening/weekly wizards are fixed, code-defined
  // views, and the parity gate's contract is "reproduce the fixed wizard
  // verbatim". A live user may already own a trackable whose id collides with a
  // reflective vocab id (`energy`, `gratitude`, `highlights`, …) but at a
  // DIFFERENT shape; if their row won, the step would render the wrong input and
  // `buildFatEntries` would emit the wrong entry — silently breaking byte-parity
  // for that user. Defaults must win so the wizard is identical for everyone.
  //
  // B3 revisits this: once users can customize view prompts (`manifest.views` /
  // custom vocab), user/custom rows should take precedence — flip back then.
  const userTrackables = useTrackables();
  const vocab = useMemo<Map<string, LifeManifestTrackable>>(() => {
    const m = new Map<string, LifeManifestTrackable>();
    for (const t of userTrackables) m.set(t.id, t);
    for (const t of DEFAULT_VIEW_TRACKABLES) m.set(t.id, t);
    return m;
  }, [userTrackables]);

  const tz = userTz();
  // Resolve templating against the user's own events (the in-memory entries
  // map), PLUS synthetic per-vocab projections of today's fat `*_session`
  // history so refs pointing at the new split vocab ids resolve in B2 (see
  // synthesizeViewEvents). Recompute when the event set changes.
  const events = useMemo<LogEvent[]>(
    () => synthesizeViewEvents(Array.from(state.entries.values())),
    [state.entries],
  );

  // Resolve every item into a concrete step or drop it. `tasks_due` / `banner`
  // lead blocks are resolved separately (rendered above the capture steps).
  const resolved = useMemo(() => {
    const leadBlocks: LeadBlock[] = [];
    const captureSteps: CaptureStep[] = [];
    if (!view) return { leadBlocks, captureSteps };
    for (const item of view.items as LifeViewItem[]) {
      if (item.kind === "tasks_due") {
        leadBlocks.push({ kind: "tasks_due" });
      } else if (item.kind === "banner") {
        const text = resolveTemplate(item.text, item.refs, events, tz);
        // Drop the banner when a required ref is unresolved (no nudge).
        if (text !== null) leadBlocks.push({ kind: "banner", text });
      } else {
        const t = vocab.get(item.trackableId);
        if (!t) continue; // unknown vocab id — degrade gracefully, don't crash.
        const promptText = t.prompt ?? t.label;
        const prompt = resolveTemplate(promptText, t.refs, events, tz);
        const hint = t.hint !== undefined ? resolveTemplate(t.hint, t.refs, events, tz) : undefined;
        // Drop the capture step when a REQUIRED ref used in its prompt/hint is
        // unresolved — reproduces today's contextKey drop for evening's
        // intention_followup. (resolveTemplate returns null only when a token
        // actually present in the text fails to resolve.)
        if (prompt === null || hint === null) continue;
        captureSteps.push({
          kind: "capture",
          trackable: t,
          optional: item.optional ?? true,
          prompt,
          hint,
        });
      }
    }
    return { leadBlocks, captureSteps };
  }, [view, vocab, events, tz]);

  const captureSteps = resolved.captureSteps;
  const stepCount = captureSteps.length;

  const [stepIndex, setStepIndex] = useUrlParam<number>("step", {
    parse: (raw) => {
      if (!raw) return 0;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) return 0;
      if (stepCount > 0 && n >= stepCount) return stepCount - 1;
      return n;
    },
    serialize: (v) => (v <= 0 ? null : String(v)),
    default: 0,
    mode: "push",
  });

  const [answers, setAnswers] = useState<Record<string, unknown>>(() =>
    view ? loadAnswers(view.id) : {},
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!view) return;
    saveAnswers(view.id, answers);
  }, [view, answers]);

  const step = captureSteps[stepIndex];
  const isLast = stepCount > 0 && stepIndex === stepCount - 1;

  if (!view) {
    return (
      <PageContainer>
        <p>Unknown view: {viewId}</p>
        <Button onClick={() => navigate("..")}>Back</Button>
      </PageContainer>
    );
  }

  const goBack = () => {
    if (stepIndex === 0) {
      // Route-relative back to the dashboard. Draft stays in sessionStorage so
      // re-entering restores in-progress work — only completion clears it.
      navigate("..");
    } else {
      const next = stepIndex - 1;
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
      setStepIndex(stepIndex + 1);
    }
  };

  const submit = async () => {
    if (!user?.uid || !state.log?.id) return;
    // Walk the FILTERED capture steps (not the raw view items): a step whose
    // required ref didn't resolve was never shown, so any stale draft answer for
    // it must not be written out.
    const entries = buildFatEntries(view.id, captureSteps, answers);
    if (entries.length === 0) {
      message.info("Nothing to save — add a value before finishing.");
      return;
    }
    setSubmitting(true);
    try {
      // Byte-identical subject_id: the legacy `*_session` the readers expect
      // (weekly maps to `weekly_review_session`, not `weekly_session`). A custom
      // View with no legacy mapping falls back to `<id>_session`.
      const subjectId = LEGACY_SESSION_SUBJECT[view.id] ?? `${view.id}_session`;
      await life.addEvent(
        state.log.id,
        subjectId,
        entries,
        user.uid,
        { labels: { source: "manual" } },
      );
      message.success(`${view.title} session saved`);
      clearAnswers(view.id);
      navigate("..");
    } catch (err) {
      console.error("Failed to save session:", err);
      message.error("Failed to save");
      setSubmitting(false);
    }
  };

  const canAdvance = step ? step.optional || answers[step.trackable.id] !== undefined : false;
  const skipLabel = step?.optional ? "Skip" : null;

  return (
    <>
      <AppHeader
        title={view.title}
        primaryAction={{
          label: "Back",
          icon: <LeftOutlined />,
          onClick: goBack,
        }}
      />
      <PageContainer>
        {stepIndex === 0 && view.greeting && (
          <Greeting>
            {VIEW_ICONS[view.icon ?? ""] && (
              <span style={{ marginRight: "var(--space-sm)" }}>{VIEW_ICONS[view.icon ?? ""]}</span>
            )}
            {view.greeting}
          </Greeting>
        )}
        {stepIndex === 0 &&
          resolved.leadBlocks.map((block, i) =>
            block.kind === "tasks_due" ? (
              <TasksDueBlock key={`tasks-${i}`} />
            ) : (
              <Banner key={`banner-${i}`}>{block.text}</Banner>
            ),
          )}
        <Progress>
          {captureSteps.map((_, i) => (
            <ProgressDot key={i} $active={i === stepIndex} $done={i < stepIndex} />
          ))}
        </Progress>

        {step && (
          <PromptCard>
            <PromptLabel htmlFor={step.trackable.id}>{step.prompt}</PromptLabel>
            {step.hint && <PromptHint>{step.hint}</PromptHint>}
            <CaptureInput
              step={step}
              value={answers[step.trackable.id]}
              onChange={(v) => setAnswer(step.trackable.id, v)}
            />
          </PromptCard>
        )}

        <ActionRow>
          {skipLabel ? (
            <Button onClick={advance} disabled={submitting}>
              {skipLabel}
            </Button>
          ) : (
            <span />
          )}
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

interface CaptureInputProps {
  step: CaptureStep;
  value: unknown;
  onChange: (v: unknown) => void;
}

/**
 * Per-shape input control. The default session vocab only uses `noted`
 * (textarea) and `rated` (1..max row), but the other shapes are handled so a
 * custom View referencing them renders something sensible.
 */
function CaptureInput({ step, value, onChange }: CaptureInputProps) {
  const { trackable } = step;
  switch (trackable.shape) {
    case "noted":
      return (
        <Input.TextArea
          id={trackable.id}
          autoFocus
          rows={3}
          placeholder={trackable.placeholder}
          value={(value as string) ?? ""}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value || undefined)}
        />
      );
    case "rated": {
      // The default `energy` row keeps the 1–5 scale today's session used.
      const max = 5;
      const selected = typeof value === "number" ? value : null;
      return (
        <RatingRow>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <RatingButton key={n} type="button" $selected={selected === n} onClick={() => onChange(n)}>
              {n}
            </RatingButton>
          ))}
        </RatingRow>
      );
    }
    default:
      // took/did/happened are not exercised by the default sessions; a custom
      // View referencing them gets a plain text fallback rather than a crash.
      return (
        <Input
          id={trackable.id}
          autoFocus
          placeholder={trackable.placeholder}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
  }
}
