/**
 * Habit board — the goal/trackable review surface on the Daily screen. It is a
 * CALENDAR view over
 * the unified task/trackable model: every goal and every plain trackable gets a
 * Su–Sa multi-week `TrackerCalendar` so last week's context, day labels, a today
 * marker, and history are all legible at a glance (replacing the old single-week
 * pip strip).
 *
 * Two sections:
 *   - Goals (top): each visible goal keeps its at-a-glance status (label,
 *     value/target, met ✓ / cap headroom-or-over, + Log for unmet at_least),
 *     with a goal-overlaid calendar below. Weekly goals add a
 *     "this week N/target · last week M/target" context line.
 *   - All trackables (below, collapsible): every non-hidden trackable not
 *     already a goal's primary thing gets a plain (binary) calendar.
 *
 * Tap a calendar cell to BACKFILL or EDIT that day (see `handleTapDay`):
 *   - empty + a usable default + a tap that would count → log a default event
 *     timestamped to that day at local noon (tz-correct day bucket);
 *   - empty + group/rated/no-default → open the shape sheet against that day;
 *   - populated → edit via the unified EventsEditModal (renders 1..n events).
 *
 * All day math is tz-aware (the day index + the goal evaluator share the same
 * tz helpers); there is no runtime setHours bucketing here. There is no in-app
 * goal editor — authoring is MCP-only — so the empty state points at Claude.
 */
import { useCallback, useMemo, useState } from "react";
import styled from "styled-components";
import { Button } from "antd";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import { SortableList, SortableRow } from "./SortableList";
import type {
  LifeEvent,
  LifeManifestTrackable,
  LifeGoal,
  TrackableShape,
} from "@homelab/backend";
import { evaluateGoal, zonedDateTime, type GoalProgress } from "@homelab/backend";
import { buildEntries, formatUnitValue, isInputEligible } from "../lib/shapes";
import { userTz } from "../lib/useUserTz";
import { useLogEvent } from "../lib/useLogEvent";
import { buildDayIndex } from "../lib/dayIndex";
import { TrackerCalendar } from "./TrackerCalendar";
import { HabitHistory } from "./HabitHistory";
import { EventsEditModal } from "./EventsEditModal";

// How many weeks each board calendar shows: a single Su–Sa strip per habit,
// keeping the board clean and short-timeline. The longer history (year heatmap +
// per-month grids) is one tap away — tapping a habit's name opens HabitHistory.
const BOARD_WEEKS = 1;

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const Wrap = styled.div`
  margin-top: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
`;

const Header = styled.div`
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: var(--space-xs);
`;

/** Top board bar: the "Habits" label on the left, the Reorder/Done toggle right. */
const BoardBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
`;

const EditToggle = styled.button`
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 2px 4px;
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-primary);
  cursor: pointer;

  &:hover { text-decoration: underline; }
`;

/** A compact reorder-mode row: just the habit's name (the handle is supplied by SortableRow). */
const ReorderName = styled.div`
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
`;

const Card = styled.div<{ $over?: boolean }>`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid ${(p) => (p.$over ? "var(--color-warning, #faad14)" : "var(--color-border)")};
  border-radius: var(--radius-md);
  background: var(--color-bg);
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
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

/** Tappable habit name → opens the per-habit history screen. */
const LabelButton = styled.button`
  align-self: flex-start;
  max-width: 100%;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  font-weight: 500;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover { color: var(--color-primary); text-decoration: underline; }
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

const WeekContext = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
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

const ExpanderButton = styled.button`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  width: 100%;
  background: none;
  border: none;
  padding: var(--space-xs) 0;
  cursor: pointer;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;

  .anticon { font-size: 11px; }
`;

const TrackableRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
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
 * Resolve the subjectIds a goal's scope selects, MATCHING the evaluator: a thing
 * scope is its one id; a group scope is every member whose `group` matches and
 * that is non-hidden OR is the hidden husk whose id === the group name.
 */
function scopeSubjectIds(goal: LifeGoal, trackables: LifeManifestTrackable[]): string[] {
  if ("thing" in goal.scope) return [goal.scope.thing];
  const group = goal.scope.group;
  return trackables
    .filter((t) => t.group === group && (!t.hidden || t.id === group))
    .map((t) => t.id);
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
    case "noted":
      return null; // reflective text has no default; never reaches here anyway
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
    if (thing.shape !== "took") return false;
    if (thing.defaultUnit !== goal.unit) return false;
  }
  return true;
}

/**
 * Splice a reordered VISIBLE subset of ids back into the FULL order, leaving
 * non-subset ids (e.g. goal primaries / hidden trackables, or hidden goals) in
 * their original slots. The subset positions are filled in the subset's new
 * order; the result is a complete permutation of all ids — what the manifest
 * reorder ops (`reorderTrackables` / `reorderGoals`) require. Used for both the
 * trackable long tail and the goals section, since each renders only its
 * visible members but persists a full permutation.
 */
export function spliceVisibleOrder(allIds: string[], orderedSubsetIds: string[]): string[] {
  const subset = new Set(orderedSubsetIds);
  let cursor = 0;
  return allIds.map((id) => (subset.has(id) ? orderedSubsetIds[cursor++] : id));
}

interface GoalRow {
  goal: LifeGoal;
  progress: GoalProgress;
  subjectIds: string[];
  /** Resolved thing for tap-to-log (thing scope); null for group scope. */
  thing: LifeManifestTrackable | null;
  /** Weekly only: this-week and last-week metric values for the context line. */
  weekContext: { thisWeek: number; lastWeek: number } | null;
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
  /**
   * Opens a shape's bottom sheet for backfill. The optional date routes the
   * sheet to log against that day (group scope, rated, or no-default things);
   * omitted → the sheet's current viewed day.
   */
  onOpenShape: (shape: TrackableShape, backfillDay?: Date) => void;
}

export function HabitBoard({
  trackables,
  goals,
  events,
  day,
  userId,
  logId,
  onOpenShape,
}: HabitBoardProps) {
  const logEvent = useLogEvent();
  const life = useLifeBackend();
  const { message } = useFeedback();

  // Bucket the calendar + evaluate goal boundaries in the USER's tz (the same
  // saved tz the server progress route uses), so the dashboard and server agree
  // on which day/week an event near midnight lands in.
  const tz = userTz();

  // ONE O(events) pass feeds every calendar cell — no per-cell event scans.
  const index = useMemo(() => buildDayIndex(events, tz), [events, tz]);

  // The calendar always anchors on the REAL today (marker + future cutoff +
  // history window), independent of the DateNav's viewed `day`. The viewed day
  // still drives goal STATUS evaluation (value/target/streak) below, so a
  // calendar tap and the status can describe different days — by design: the
  // grid is for browsing/backfilling history, the status row for the chosen day.
  const realToday = useMemo(() => new Date(), [events]);

  const visibleGoals = useMemo(() => goals.filter((g) => !g.hidden), [goals]);

  const goalRows = useMemo<GoalRow[]>(() => {
    return visibleGoals.map((goal) => {
      const progress = evaluateGoal(goal, events, trackables, tz, day);
      const subjectIds = scopeSubjectIds(goal, trackables);
      const thingId = "thing" in goal.scope ? goal.scope.thing : null;
      const thing = thingId ? trackables.find((t) => t.id === thingId) ?? null : null;
      let weekContext: GoalRow["weekContext"] = null;
      if (goal.period === "week") {
        // Last week = the same evaluator on a refDate 7 days back (tz-safe step).
        const lastWeekRef = new Date(day.getTime() - 7 * 24 * 60 * 60 * 1000);
        const last = evaluateGoal(goal, events, trackables, tz, lastWeekRef);
        weekContext = { thisWeek: progress.value, lastWeek: last.value };
      }
      return { goal, progress, subjectIds, thing, weekContext };
    });
  }, [visibleGoals, events, trackables, day, tz]);

  // Trackables NOT already a goal's PRIMARY thing (thing-scope goals only — a
  // group goal doesn't claim its members as primaries, so they still show in the
  // long tail). `isInputEligible` excludes hidden AND reflective (`noted`) rows
  // — the long-tail is an input/tap-to-log surface, so reflective vocab (View-
  // only) must not appear here. Rendered in manifest order.
  const goalThingIds = useMemo(
    () => new Set(visibleGoals.flatMap((g) => ("thing" in g.scope ? [g.scope.thing] : []))),
    [visibleGoals],
  );
  const longTail = useMemo(
    () => trackables.filter((t) => isInputEligible(t) && !goalThingIds.has(t.id)),
    [trackables, goalThingIds],
  );

  const [expanded, setExpanded] = useState(false);

  // Edit surface for a tapped populated day: the unified modal renders N events
  // (one or several), each editable/deletable.
  const [editEvents, setEditEvents] = useState<LifeEvent[] | null>(null);

  // Per-habit history screen (year heatmap + month grids + stats). Opened by
  // tapping a habit's name; carries the trackable + its goal (if any).
  const [history, setHistory] = useState<{ thing: LifeManifestTrackable; goal: LifeGoal | null } | null>(null);

  // "Reorder" edit mode: reveals drag handles and swaps each section for a
  // compact, drag-only list. Reordering goals and trackables are independent
  // per-section permutations (the two groups render distinctly), persisted via
  // the manifest reorder ops so the order survives reload.
  const [editing, setEditing] = useState(false);

  const persistOrder = useCallback(
    async (kind: "goals" | "trackables", orderedIds: string[]) => {
      if (!logId) return;
      try {
        if (kind === "goals") await life.reorderGoals(logId, orderedIds);
        else await life.reorderTrackables(logId, orderedIds);
      } catch (err) {
        console.error(`Failed to reorder ${kind}:`, err);
        message.error("Couldn't save the new order");
      }
    },
    [life, logId, message],
  );

  // Reordering the long tail must preserve manifest order for the trackables NOT
  // shown there (goal primaries + hidden). We splice the reordered long-tail ids
  // back into the full trackable order so the permutation the op requires stays
  // complete.
  const reorderLongTail = useCallback(
    (orderedLongTailIds: string[]) => {
      const fullOrder = spliceVisibleOrder(trackables.map((t) => t.id), orderedLongTailIds);
      void persistOrder("trackables", fullOrder);
    },
    [trackables, persistOrder],
  );

  // Same splice for goals: the section renders only VISIBLE goals, but
  // `reorderGoals` requires a full permutation of ALL goals (hidden included).
  // Splice the reordered visible ids back into the full goal order so a hidden
  // goal doesn't trip the op's permutation check.
  const reorderGoalsList = useCallback(
    (orderedVisibleIds: string[]) => {
      const fullOrder = spliceVisibleOrder(goals.map((g) => g.id), orderedVisibleIds);
      void persistOrder("goals", fullOrder);
    },
    [goals, persistOrder],
  );

  // ---- Tap-to-log / backfill / edit ------------------------------------

  /**
   * Backfill or edit the tapped day. `subjectIds`/`thing` describe the calendar's
   * scope; `date` is local noon of the tapped day (already tz-correct, so a
   * default log lands in the right day bucket). For a thing-scope goal `goal` is
   * passed so unit-mismatch no-ops fall back to the sheet.
   */
  const handleTapDay = async (
    subjectIds: string[],
    thing: LifeManifestTrackable | null,
    goal: LifeGoal | undefined,
    date: Date,
    dayEvts: LifeEvent[],
  ) => {
    // Populated day → edit the lot (the unified modal handles 1..n).
    if (dayEvts.length > 0) {
      setEditEvents(dayEvts);
      return;
    }
    // Empty day → backfill. Group scope, a rated thing, a thing with no usable
    // default, or a goal whose default wouldn't count → open the sheet against
    // this day so the user supplies a real value (never a silent wrong-day log).
    if (!logId || !userId) return;
    if (!thing) {
      // Group scope: default to a member's shape for the sheet. Only an
      // input-eligible member can drive a sheet (reflective `noted` has none).
      const shape = trackables.find((t) => subjectIds.includes(t.id) && isInputEligible(t))?.shape;
      if (shape) onOpenShape(shape, date);
      return;
    }
    if (goal && !tapWouldCount(goal, thing)) {
      onOpenShape(thing.shape, date);
      return;
    }
    const entries = defaultEntriesFor(thing);
    if (!entries) {
      onOpenShape(thing.shape, date);
      return;
    }
    await logEvent({
      logId,
      userId,
      subjectId: thing.id,
      entries,
      timestamp: date, // local noon of the tapped day
      label: thing.label,
    });
  };

  /**
   * Delete a `happened` day's events with an Undo toast that re-creates the
   * exact events deleted (captured before deletion). The toast names the count.
   */
  const deleteWithUndo = useCallback(
    async (thing: LifeManifestTrackable, dayEvts: LifeEvent[]) => {
      if (dayEvts.length === 0 || !logId || !userId) return;
      const snapshot = dayEvts; // captured before delete
      // allSettled, not all: a rejection on one delete must not strand the
      // already-succeeded deletes with no Undo affordance. If ANY delete
      // succeeded we still surface the Undo toast — Undo re-creates the full
      // original day from the in-memory snapshot, so it's a clean inverse
      // regardless of which deletes failed. Only when every delete fails do we
      // show the plain error toast (nothing was removed, nothing to undo).
      const results = await Promise.allSettled(snapshot.map((e) => life.deleteEvent(e.id)));
      const anySucceeded = results.some((r) => r.status === "fulfilled");
      if (!anySucceeded) {
        const firstErr = results.find((r) => r.status === "rejected");
        console.error(
          "Failed to remove entries:",
          firstErr && firstErr.status === "rejected" ? firstErr.reason : undefined,
        );
        message.error("Failed to remove");
        return;
      }
      const n = snapshot.length;
      const key = `toggled-off-${thing.id}-${Date.now()}`;
      message.open({
        key,
        type: "success",
        duration: 5,
        content: (
          <span>
            Removed {n} {n === 1 ? "entry" : "entries"}
            <Button
              type="link"
              size="small"
              onClick={async () => {
                message.destroy(key);
                try {
                  // Re-create each deleted event faithfully (entries, timestamp,
                  // endTime, labels) so Undo is a true inverse.
                  await Promise.all(
                    snapshot.map((e) =>
                      life.addEvent(logId, e.subjectId, e.entries, userId, {
                        timestamp: e.timestamp,
                        endTime: e.endTime,
                        labels: e.labels,
                      }),
                    ),
                  );
                } catch (err) {
                  console.error("Undo failed:", err);
                  message.error("Undo failed");
                }
              }}
            >
              Undo
            </Button>
          </span>
        ),
      });
    },
    [life, message, logId, userId],
  );

  /**
   * SHORT tap on a `happened` (binary) cell: toggle the day. Empty → backfill a
   * default event (existing path); filled → delete that day's events + Undo. For
   * `took`/`did`/`rated` things, a tap opens the editor (handled by `handleTapDay`).
   */
  const handleToggleDay = async (
    thing: LifeManifestTrackable,
    goal: LifeGoal | undefined,
    date: Date,
    dayEvts: LifeEvent[],
  ) => {
    if (dayEvts.length > 0) {
      await deleteWithUndo(thing, dayEvts);
      return;
    }
    // Empty → reuse the backfill path (default event at the day's local noon).
    await handleTapDay([thing.id], thing, goal, date, []);
  };

  // ---- Goal status row: + Log against the VIEWED day (status reflects it) ---

  const logThing = async (goal: LifeGoal, thing: LifeManifestTrackable | null) => {
    // Reuse the tap path against the viewed day (user-tz noon), so a status-row
    // log and a calendar tap on today behave identically and bucket correctly.
    const noon = zonedDateTime(day, 12, 0, tz);
    await handleTapDay(scopeSubjectIds(goal, trackables), thing, goal, noon, []);
  };

  if (visibleGoals.length === 0 && longTail.length === 0) {
    return (
      <Wrap data-testid="habit-board">
        <Header>Habits</Header>
        <EmptyHint data-testid="habit-board-empty">
          No goals yet — set them with Claude (e.g. "track 64 oz of water a day").
        </EmptyHint>
      </Wrap>
    );
  }

  // Edit mode is reachable whenever there's more than one habit to reorder
  // across the two sections (a single habit has nothing to sort).
  const canReorder = !!logId && visibleGoals.length + longTail.length >= 2;

  return (
    <Wrap data-testid="habit-board">
      <BoardBar>
        <Header style={{ margin: 0 }}>Habits</Header>
        {canReorder && (
          <EditToggle
            type="button"
            onClick={() => setEditing((e) => !e)}
            data-testid="reorder-toggle"
          >
            {editing ? "Done" : "Reorder"}
          </EditToggle>
        )}
      </BoardBar>

      {visibleGoals.length === 0 ? (
        <EmptyHint data-testid="habit-board-empty">
          No goals yet — set them with Claude (e.g. "track 64 oz of water a day").
        </EmptyHint>
      ) : editing ? (
        <div>
          <Header>Goals</Header>
          <List data-testid="goals-reorder-list">
            <SortableList
              ids={visibleGoals.map((g) => g.id)}
              onReorder={reorderGoalsList}
            >
              {visibleGoals.map((goal) => (
                <SortableRow key={goal.id} id={goal.id}>
                  <ReorderName>{goal.label}</ReorderName>
                </SortableRow>
              ))}
            </SortableList>
          </List>
        </div>
      ) : (
        <div>
          <Header>Goals</Header>
          <List>
            {goalRows.map(({ goal, progress, subjectIds, thing, weekContext }) => {
              const isCap = goal.kind === "at_most";
              const over = isCap && !progress.met;
              const canTapLog = !isCap && !progress.met;
              return (
                <Card key={goal.id} $over={over} data-testid="habit-row">
                  <StatusRow>
                    {!isCap && (
                      <Mark $met={progress.met} aria-hidden>{progress.met ? "✓" : ""}</Mark>
                    )}
                    <Body>
                      {thing ? (
                        <LabelButton
                          type="button"
                          onClick={() => setHistory({ thing, goal })}
                          data-testid="goal-name"
                        >
                          {goal.label}
                        </LabelButton>
                      ) : (
                        <Label>{goal.label}</Label>
                      )}
                      {isCap && (
                        <Sub>{over ? "over cap" : `${fmtValue(goal, progress.remaining)} left`}</Sub>
                      )}
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
                  </StatusRow>
                  {weekContext && (
                    <WeekContext data-testid="habit-week-context">
                      this week {fmtValue(goal, weekContext.thisWeek)}/{fmtValue(goal, goal.target)}
                      {" · "}
                      last week {fmtValue(goal, weekContext.lastWeek)}/{fmtValue(goal, goal.target)}
                    </WeekContext>
                  )}
                  <TrackerCalendar
                    subjectIds={subjectIds}
                    goal={goal}
                    weeks={BOARD_WEEKS}
                    index={index}
                    tz={tz}
                    today={realToday}
                    // `happened` thing → tap toggles; long press opens the editor.
                    // Everything else → tap opens the editor (long press too).
                    onTapDay={(date, evts) =>
                      thing?.shape === "happened"
                        ? void handleToggleDay(thing, goal, date, evts)
                        : void handleTapDay(subjectIds, thing, goal, date, evts)
                    }
                    onLongPressDay={(date, evts) =>
                      void handleTapDay(subjectIds, thing, goal, date, evts)
                    }
                  />
                </Card>
              );
            })}
          </List>
        </div>
      )}

      {longTail.length > 0 && editing && (
        <div>
          <Header>All trackables</Header>
          <List data-testid="long-tail-reorder-list">
            <SortableList ids={longTail.map((t) => t.id)} onReorder={reorderLongTail}>
              {longTail.map((t) => (
                <SortableRow key={t.id} id={t.id}>
                  <ReorderName>{t.label}</ReorderName>
                </SortableRow>
              ))}
            </SortableList>
          </List>
        </div>
      )}

      {longTail.length > 0 && !editing && (
        <div>
          <ExpanderButton
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            data-testid="long-tail-expander"
          >
            {expanded ? <DownOutlined /> : <RightOutlined />}
            All trackables ({longTail.length})
          </ExpanderButton>
          {expanded && (
            <List data-testid="long-tail-list">
              {longTail.map((t) => (
                <TrackableRow key={t.id} data-testid="trackable-row">
                  <LabelButton
                    type="button"
                    onClick={() => setHistory({ thing: t, goal: null })}
                    data-testid="trackable-name"
                  >
                    {t.label}
                  </LabelButton>
                  <TrackerCalendar
                    subjectIds={[t.id]}
                    weeks={BOARD_WEEKS}
                    index={index}
                    tz={tz}
                    today={realToday}
                    onTapDay={(date, evts) =>
                      t.shape === "happened"
                        ? void handleToggleDay(t, undefined, date, evts)
                        : void handleTapDay([t.id], t, undefined, date, evts)
                    }
                    onLongPressDay={(date, evts) => void handleTapDay([t.id], t, undefined, date, evts)}
                  />
                </TrackableRow>
              ))}
            </List>
          )}
        </div>
      )}

      <HabitHistory
        open={history !== null}
        thing={history?.thing ?? null}
        goal={history?.goal ?? null}
        index={index}
        events={events}
        tz={tz}
        today={realToday}
        onClose={() => setHistory(null)}
        onTapDay={(thing, goal, date, evts) =>
          thing.shape === "happened"
            ? void handleToggleDay(thing, goal ?? undefined, date, evts)
            : void handleTapDay([thing.id], thing, goal ?? undefined, date, evts)
        }
        onLongPressDay={(thing, goal, date, evts) =>
          void handleTapDay([thing.id], thing, goal ?? undefined, date, evts)
        }
      />

      <EventsEditModal
        events={editEvents}
        trackables={trackables}
        onClose={() => setEditEvents(null)}
      />
    </Wrap>
  );
}
