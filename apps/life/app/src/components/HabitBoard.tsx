/**
 * Habit board — the goal review lens on the dashboard. Swaps in for DayTimeline
 * in the same slot (the Timeline · Habits toggle). It interprets the user's
 * goals (manifest.goals[]) against the day's events via the pure `evaluateGoal`
 * — it adds NO event data, it just reports adherence.
 *
 * Date-aware off `selectedDate`:
 *   - Daily at_least goals → a check + value/target + tap-to-log when unmet.
 *   - Daily at_most caps   → a read-only headroom meter (amber when over).
 *   - Weekly goals         → value/target progress with day pips for the week.
 *
 * Tap-to-log resolves the goal's default payload from its scope:
 *   - thing scope → replay the trackable's default event for its shape
 *     (happened→count 1; took→defaultAmount+defaultUnit; did→defaultDuration;
 *      rated→open that shape's sheet, since a rating needs a value).
 *   - group scope → can't pick one thing, so open that group's shape sheet.
 *
 * There is no in-app goal editor yet — authoring is MCP-only — so the empty
 * state points the user at Claude.
 */
import { useMemo } from "react";
import styled from "styled-components";
import type {
  LifeEvent,
  LifeManifestTrackable,
  LifeGoal,
  TrackableShape,
} from "@homelab/backend";
import { evaluateGoal, type GoalProgress } from "../lib/goals";
import { buildEntries, formatUnitValue } from "../lib/shapes";
import { useLogEvent } from "../lib/useLogEvent";

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const Wrap = styled.div`
  margin-top: var(--space-md);
`;

const Header = styled.div`
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: var(--space-xs);
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const Card = styled.div<{ $over?: boolean }>`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid ${(p) => (p.$over ? "var(--color-warning, #faad14)" : "var(--color-border)")};
  border-radius: var(--radius-md);
  background: var(--color-bg);
`;

const Mark = styled.span<{ $met: boolean }>`
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 2px solid ${(p) => (p.$met ? "var(--color-success, #52c41a)" : "var(--color-border)")};
  background: ${(p) => (p.$met ? "var(--color-success, #52c41a)" : "transparent")};
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
`;

const Body = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const Label = styled.span`
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Sub = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: var(--space-xs);
`;

const Progress = styled.span<{ $over?: boolean }>`
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: ${(p) => (p.$over ? "var(--color-warning, #faad14)" : "var(--color-text)")};
`;

const Streak = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const Pips = styled.div`
  display: flex;
  gap: 3px;
  margin-top: 2px;
`;

const Pip = styled.span<{ $filled: boolean }>`
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: ${(p) => (p.$filled ? "var(--color-primary)" : "var(--color-border)")};
`;

const LogButton = styled.button`
  flex-shrink: 0;
  border: 1px solid var(--color-primary);
  background: var(--color-bg);
  color: var(--color-primary);
  border-radius: 999px;
  padding: 4px 12px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;

  &:hover { background: var(--color-primary-light, var(--color-bg-muted)); }
  &:disabled { opacity: 0.5; cursor: default; }
`;

const EmptyHint = styled.div`
  font-size: var(--font-size-sm);
  font-style: italic;
  color: var(--color-text-muted, var(--color-text-secondary));
  padding: var(--space-xs) 0;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a metric value for display: sum uses its unit, else a bare number. */
function fmtValue(goal: LifeGoal, value: number): string {
  if (goal.metric === "sum" && goal.unit) return formatUnitValue(value, goal.unit);
  return String(value);
}

/**
 * Build the default replay payload for a `thing`-scoped tap-to-log, mirroring
 * the canonical per-shape construction (buildEntries). Returns null when the
 * shape needs an explicit value the goal can't supply (rated, or a `took`/`did`
 * with no usable default) — the caller falls back to opening the shape sheet.
 */
function defaultEntriesFor(t: LifeManifestTrackable) {
  switch (t.shape) {
    case "happened":
      return buildEntries("happened", {});
    case "took":
      return buildEntries("took", { amount: t.defaultAmount ?? null, unit: t.defaultUnit });
    case "did":
      return buildEntries("did", { duration: t.defaultDuration ?? null });
    case "rated":
      return null; // a rating has no sensible default — open the sheet
  }
}

/**
 * Would a default tap-to-log for `thing` actually move this goal's value? A
 * thing with no usable default (rated) can't. And a `sum`/`unit` goal only
 * counts number entries whose unit === goal.unit, so a thing whose default
 * payload carries a different unit (e.g. a "drinks" cap over a thing whose
 * default is "oz") would log an event that doesn't count — a confusing no-op.
 * In those cases we fall back to opening the shape sheet so the user supplies a
 * value (and unit) that actually registers.
 */
function tapWouldCount(goal: LifeGoal, thing: LifeManifestTrackable): boolean {
  if (defaultEntriesFor(thing) === null) return false;
  if (goal.metric === "sum") {
    // `took` is the only shape that writes a unit-bearing number on its default;
    // it must match the goal's unit to be summed. Other shapes write no unit.
    if (thing.shape !== "took") return false;
    if (thing.defaultUnit !== goal.unit) return false;
  }
  return true;
}

interface DailyRow {
  goal: LifeGoal;
  progress: GoalProgress;
  /** Resolved thing for tap-to-log (thing scope); null for group scope. */
  thing: LifeManifestTrackable | null;
}

interface WeeklyRow {
  goal: LifeGoal;
  progress: GoalProgress;
  /** 7 booleans Sun..Sat: did this group/thing have a qualifying event? */
  pips: boolean[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface HabitBoardProps {
  trackables: LifeManifestTrackable[];
  goals: LifeGoal[];
  events: LifeEvent[];
  /** The day being viewed (start of day). */
  day: Date;
  userId: string;
  logId: string | undefined;
  /** Timestamp to log against for the viewed day (undefined = now/today). */
  timestamp?: Date;
  /** Opens a shape's bottom sheet (group scope + rated thing fallback). */
  onOpenShape: (shape: TrackableShape) => void;
}

export function HabitBoard({
  trackables,
  goals,
  events,
  day,
  userId,
  logId,
  timestamp,
  onOpenShape,
}: HabitBoardProps) {
  const logEvent = useLogEvent();

  // Evaluate goal boundaries in the BROWSER's tz so the dashboard agrees with
  // the server progress route (which uses the log owner's saved tz). In the
  // browser the runtime tz already equals this, so the pip day-windows below
  // (runtime setHours/setDate) line up with the evaluator's periods.
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const visibleGoals = useMemo(() => goals.filter((g) => !g.hidden), [goals]);

  const daily = useMemo<DailyRow[]>(() => {
    return visibleGoals
      .filter((g) => g.period === "day")
      .map((goal) => {
        const progress = evaluateGoal(goal, events, trackables, tz, day);
        const thingId = "thing" in goal.scope ? goal.scope.thing : null;
        const thing = thingId ? trackables.find((t) => t.id === thingId) ?? null : null;
        return { goal, progress, thing };
      });
  }, [visibleGoals, events, trackables, day, tz]);

  const weekly = useMemo<WeeklyRow[]>(() => {
    return visibleGoals
      .filter((g) => g.period === "week")
      .map((goal) => {
        const progress = evaluateGoal(goal, events, trackables, tz, day);
        // Day pips: one per day Sun..Sat of the goal's week, filled when that
        // day had ≥1 qualifying event (re-using the evaluator's day metric on a
        // single-day window keeps the "qualifying" definition identical).
        const subjectIds = new Set(
          "thing" in goal.scope
            ? [goal.scope.thing]
            : trackables
                .filter((t) => !t.hidden && t.group === (goal.scope as { group: string }).group)
                .map((t) => t.id),
        );
        const pips: boolean[] = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(progress.periodStart);
          d.setDate(d.getDate() + i);
          const lo = new Date(d); lo.setHours(0, 0, 0, 0);
          const hi = new Date(d); hi.setHours(23, 59, 59, 999);
          pips.push(events.some((e) => subjectIds.has(e.subjectId) && e.timestamp >= lo && e.timestamp <= hi));
        }
        return { goal, progress, pips };
      });
  }, [visibleGoals, events, trackables, day, tz]);

  if (visibleGoals.length === 0) {
    return (
      <Wrap data-testid="habit-board">
        <Header>Habits</Header>
        <EmptyHint data-testid="habit-board-empty">
          No goals yet — set them with Claude (e.g. "track 64 oz of water a day").
        </EmptyHint>
      </Wrap>
    );
  }

  const logThing = async (goal: LifeGoal, thing: LifeManifestTrackable | null) => {
    if (!logId || !userId) return;
    // Group scope (or a rated thing, or a thing with no default) → open the
    // shape sheet so the user picks the value. For group scope, default to the
    // first non-hidden member's shape (group members share a shape in practice).
    if (!thing) {
      if ("group" in goal.scope) {
        const group = goal.scope.group;
        const member = trackables.find((t) => !t.hidden && t.group === group);
        if (member) onOpenShape(member.shape);
      }
      return;
    }
    // A rated thing, a thing with no usable default, or a sum/unit goal whose
    // default payload wouldn't be counted (unit mismatch) → open the sheet so
    // the user supplies a value/unit that actually registers, rather than a
    // silent no-op.
    if (!tapWouldCount(goal, thing)) {
      onOpenShape(thing.shape);
      return;
    }
    const entries = defaultEntriesFor(thing);
    if (!entries) {
      onOpenShape(thing.shape);
      return;
    }
    await logEvent({
      logId,
      userId,
      subjectId: thing.id,
      entries,
      timestamp,
      label: thing.label,
    });
  };

  return (
    <Wrap data-testid="habit-board">
      <Header>Habits</Header>
      <List>
        {daily.map(({ goal, progress, thing }) => {
          const isCap = goal.kind === "at_most";
          const over = isCap && !progress.met;
          const canTapLog = !isCap && !progress.met;
          return (
            <Card key={goal.id} $over={over} data-testid="habit-row">
              {!isCap && (
                <Mark $met={progress.met} aria-hidden>{progress.met ? "✓" : ""}</Mark>
              )}
              <Body>
                <Label>{goal.label}</Label>
                <Sub>
                  {isCap
                    ? over
                      ? "over cap"
                      : `${fmtValue(goal, progress.remaining)} left`
                    : null}
                  {progress.streak > 0 && <Streak>🔥 {progress.streak}</Streak>}
                </Sub>
              </Body>
              <Progress $over={over} data-testid="habit-progress">
                {fmtValue(goal, progress.value)}/{fmtValue(goal, goal.target)}
              </Progress>
              {canTapLog && (
                <LogButton
                  disabled={!logId}
                  onClick={() => logThing(goal, thing)}
                  data-testid="habit-log"
                >
                  + Log
                </LogButton>
              )}
            </Card>
          );
        })}
        {weekly.map(({ goal, progress, pips }) => (
          <Card key={goal.id} data-testid="habit-row">
            <Mark $met={progress.met} aria-hidden>{progress.met ? "✓" : ""}</Mark>
            <Body>
              <Label>{goal.label}</Label>
              <Pips data-testid="habit-pips">
                {pips.map((filled, i) => (
                  <Pip key={i} $filled={filled} />
                ))}
              </Pips>
              {progress.streak > 0 && <Sub><Streak>🔥 {progress.streak} wk</Streak></Sub>}
            </Body>
            <Progress data-testid="habit-progress">
              {fmtValue(goal, progress.value)}/{fmtValue(goal, goal.target)}
            </Progress>
          </Card>
        ))}
      </List>
    </Wrap>
  );
}
