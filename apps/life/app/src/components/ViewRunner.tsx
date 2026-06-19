/**
 * Data-driven guided ViewRunner — the guided wizard on the INPUT side. Given a
 * `viewId`, it resolves a `LifeView` from `useViews()` and renders its `items`
 * as a guided wizard reproducing the morning / evening / weekly session UX
 * (greeting, step dots, back/next, sessionStorage draft, `?step=` URL param).
 *
 * ── PER-ITEM WRITE (the B3.2 cutover) ───────────────────────────────────────
 * On finish, the run writes N PER-ITEM `life_events` rows — one per captured,
 * non-empty item — each under its OWN vocab `subject_id`, with canonical
 * shape entries (`buildEntries`), correlated by labels:
 *
 *     addEvent(logId, item.trackableId, buildEntries(shape, values), uid, {
 *       timestamp: runTs,
 *       labels: { source: "manual", view: viewId, view_run: runTsIso },
 *     })
 *
 * One shared `runTs` / `view_run` for the whole run so the N events co-group as
 * a single session run (see `normalizeSessionRuns` in @homelab/backend, which
 * every reader funnels through). Templating refs (`{plan}`, `{wk}`) resolve
 * against the real per-item events in `state.entries` directly.
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
import { buildEntries } from "../lib/shapes";
import { resolveTemplate } from "../lib/templating";
import { userTz } from "../lib/useUserTz";
import type { LogEvent } from "../types";
import { TasksDueBlock } from "./TasksDueBlock";

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
 * Map a wizard answer (raw form value) to the `ShapeFormValues` `buildEntries`
 * expects, per the vocab's shape. The default session vocab only uses `noted`
 * (text) + `rated` (1–5 rating); the other shapes are handled so a custom View
 * referencing them produces a sensible canonical event. Returns null for an
 * empty/missing answer so the run sparsely skips it (matches the old path).
 */
function entriesForStep(step: CaptureStep, answer: unknown): LifeEntry[] | null {
  const { shape } = step.trackable;
  switch (shape) {
    case "noted":
      return typeof answer === "string" ? buildEntries("noted", { text: answer }) : null;
    case "rated":
      return typeof answer === "number" ? buildEntries("rated", { rating: answer, scale: 5 }) : null;
    case "took":
      return typeof answer === "number"
        ? buildEntries("took", { amount: answer, unit: step.trackable.defaultUnit })
        : null;
    case "did":
      return typeof answer === "number" ? buildEntries("did", { duration: answer }) : null;
    case "happened":
      // happened captures presence; any non-empty answer logs the count event.
      return answer !== undefined && answer !== null && answer !== ""
        ? buildEntries("happened", {})
        : null;
  }
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
  // The morning/evening/weekly wizards are fixed, code-defined views. A live
  // user may already own a trackable whose id collides with a reflective vocab
  // id (`energy`, `gratitude`, `highlights`, …) but at a DIFFERENT shape; if
  // their row won, the step would render the wrong input control and write the
  // wrong shape's entries (e.g. a `did` duration instead of the `rated` rating).
  // Defaults must win so the wizard is identical for everyone.
  //
  // A later phase revisits this: once users can customize view prompts
  // (`manifest.views` / custom vocab), user/custom rows should take precedence.
  const userTrackables = useTrackables();
  const vocab = useMemo<Map<string, LifeManifestTrackable>>(() => {
    const m = new Map<string, LifeManifestTrackable>();
    for (const t of userTrackables) m.set(t.id, t);
    for (const t of DEFAULT_VIEW_TRACKABLES) m.set(t.id, t);
    return m;
  }, [userTrackables]);

  const tz = userTz();
  // Resolve templating against the user's own per-item events (the in-memory
  // entries map). Refs like evening's `{plan}` (→ `daily_intention`) and
  // morning's `{wk}` (→ `weekly_intention`) point at the per-item vocab ids the
  // ViewRunner writes, so they resolve directly. Recompute when the set changes.
  const events = useMemo<LogEvent[]>(
    () => Array.from(state.entries.values()),
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
    // it must not be written out. Each captured, non-empty step becomes ONE
    // per-item event under its own vocab subject_id.
    const captured: { trackableId: string; entries: LifeEntry[] }[] = [];
    for (const step of captureSteps) {
      const entries = entriesForStep(step, answers[step.trackable.id]);
      if (entries && entries.length > 0) {
        captured.push({ trackableId: step.trackable.id, entries });
      }
    }
    if (captured.length === 0) {
      message.info("Nothing to save — add a value before finishing.");
      return;
    }
    setSubmitting(true);
    try {
      // One shared run timestamp + view_run so the N events co-group as a single
      // session run (normalizeSessionRuns keys on labels.view + labels.view_run).
      const runTs = new Date();
      const runTsIso = runTs.toISOString();
      const labels = { source: "manual", view: view.id, view_run: runTsIso };
      await Promise.all(
        captured.map((c) =>
          life.addEvent(state.log!.id, c.trackableId, c.entries, user.uid, {
            timestamp: runTs,
            labels,
          }),
        ),
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
