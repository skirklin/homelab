/**
 * Habit board — the goal review lens on the dashboard. Swaps in for DayTimeline
 * in the same slot (the Timeline · Habits toggle). It is a CALENDAR view over
 * the unified task/trackable model: every goal and every plain trackable gets a
 * Su–Sa multi-week `TrackerCalendar` so last week's context, day labels, a today
 * marker, and history are all legible at a glance (replacing the old single-week
 * pip strip).
 *
 * Two sections:
 *   - Goals (top): each visible goal keeps its at-a-glance status (label,
 *     value/target, 🔥 streak, met ✓ / cap headroom-or-over, + Log for unmet
 *     at_least), with a goal-overlaid calendar below. Weekly goals add a
 *     "this week N/target · last week M/target" context line.
 *   - All trackables (below, collapsible): every non-hidden trackable not
 *     already a goal's primary thing gets a plain (binary) calendar.
 *
 * Tap a calendar cell to BACKFILL or EDIT that day (see `handleTapDay`):
 *   - empty + a usable default + a tap that would count → log a default event
 *     timestamped to that day at local noon (tz-correct day bucket);
 *   - empty + group/rated/no-default → open the shape sheet against that day;
 *   - populated → edit (one event → EventEditModal; several → a day modal).
 *
 * All day math is tz-aware (the day index + the goal evaluator share the same
 * tz helpers); there is no runtime setHours bucketing here. There is no in-app
 * goal editor — authoring is MCP-only — so the empty state points at Claude.
 */
import { useMemo, useState } from "react";
import styled from "styled-components";
import { Modal } from "antd";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import type {
  LifeEvent,
  LifeManifestTrackable,
  LifeGoal,
  TrackableShape,
} from "@homelab/backend";
import { evaluateGoal, dayKey, type GoalProgress } from "@homelab/backend";
import { buildEntries, formatUnitValue, labelFor } from "../lib/shapes";
import { useLogEvent } from "../lib/useLogEvent";
import { buildDayIndex } from "../lib/dayIndex";
import { TrackerCalendar } from "./TrackerCalendar";
import { EventEditModal } from "./EventEditModal";
import { EntriesList } from "./EntriesList";

// How many weeks each calendar shows. Goals get a fuller window; the long tail
// is shorter to keep the (potentially long) list scannable on a phone.
const GOAL_WEEKS = 6;
const TRACKABLE_WEEKS = 4;

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

  // Evaluate goal boundaries + bucket the calendar in the BROWSER's tz so the
  // dashboard agrees with the server progress route (which uses the log owner's
  // saved tz; in the browser the runtime tz equals this).
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

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
  // long tail). Hidden ones excluded. Rendered in manifest order.
  const goalThingIds = useMemo(
    () => new Set(visibleGoals.flatMap((g) => ("thing" in g.scope ? [g.scope.thing] : []))),
    [visibleGoals],
  );
  const longTail = useMemo(
    () => trackables.filter((t) => !t.hidden && !goalThingIds.has(t.id)),
    [trackables, goalThingIds],
  );

  const [expanded, setExpanded] = useState(false);

  // Edit surface for a tapped populated day: a single event opens EventEditModal;
  // several open a day modal listing them (each editable/deletable).
  const [editEvent, setEditEvent] = useState<LifeEvent | null>(null);
  const [dayEventsModal, setDayEventsModal] = useState<{ label: string; events: LifeEvent[] } | null>(null);

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
    // Populated day → edit. One event: the single-event modal. Several: a day
    // modal of the lot.
    if (dayEvts.length === 1) {
      setEditEvent(dayEvts[0]);
      return;
    }
    if (dayEvts.length > 1) {
      const label = thing ? thing.label : labelFor(trackables, subjectIds[0] ?? "");
      setDayEventsModal({ label, events: dayEvts });
      return;
    }
    // Empty day → backfill. Group scope, a rated thing, a thing with no usable
    // default, or a goal whose default wouldn't count → open the sheet against
    // this day so the user supplies a real value (never a silent wrong-day log).
    if (!logId || !userId) return;
    if (!thing) {
      // Group scope: default to a member's shape for the sheet.
      const shape = trackables.find((t) => subjectIds.includes(t.id) && !t.hidden)?.shape;
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

  // ---- Goal status row: + Log against the VIEWED day (status reflects it) ---

  const logThing = async (goal: LifeGoal, thing: LifeManifestTrackable | null) => {
    // Reuse the tap path against the viewed day (local noon), so a status-row
    // log and a calendar tap on today behave identically.
    const noon = new Date(day);
    noon.setHours(12, 0, 0, 0);
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

  return (
    <Wrap data-testid="habit-board">
      {visibleGoals.length === 0 ? (
        <EmptyHint data-testid="habit-board-empty">
          No goals yet — set them with Claude (e.g. "track 64 oz of water a day").
        </EmptyHint>
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
                      <Label>{goal.label}</Label>
                      <Sub>
                        {isCap
                          ? over
                            ? "over cap"
                            : `${fmtValue(goal, progress.remaining)} left`
                          : null}
                        {progress.streak > 0 && (
                          <Streak>🔥 {progress.streak}{goal.period === "week" ? " wk" : ""}</Streak>
                        )}
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
                    weeks={GOAL_WEEKS}
                    index={index}
                    tz={tz}
                    today={realToday}
                    onTapDay={(date, evts) => void handleTapDay(subjectIds, thing, goal, date, evts)}
                  />
                </Card>
              );
            })}
          </List>
        </div>
      )}

      {longTail.length > 0 && (
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
                  <Label>{t.label}</Label>
                  <TrackerCalendar
                    subjectIds={[t.id]}
                    weeks={TRACKABLE_WEEKS}
                    index={index}
                    tz={tz}
                    today={realToday}
                    onTapDay={(date, evts) => void handleTapDay([t.id], t, undefined, date, evts)}
                  />
                </TrackableRow>
              ))}
            </List>
          )}
        </div>
      )}

      <EventEditModal
        event={editEvent}
        trackables={trackables}
        onClose={() => setEditEvent(null)}
      />

      <Modal
        open={dayEventsModal !== null}
        onCancel={() => setDayEventsModal(null)}
        title={dayEventsModal ? `${dayEventsModal.label} · ${fmtDay(dayEventsModal.events, tz)}` : ""}
        footer={null}
        destroyOnClose
        data-testid="day-events-modal"
      >
        {dayEventsModal && (
          <EntriesList
            events={dayEventsModal.events}
            emptyText={null}
            onDeleted={(id) =>
              setDayEventsModal((cur) => {
                if (!cur) return cur;
                const next = cur.events.filter((e) => e.id !== id);
                return next.length > 0 ? { ...cur, events: next } : null;
              })
            }
          />
        )}
      </Modal>
    </Wrap>
  );
}

/** Short date label for the day-events modal title (tz-aware day of the events). */
function fmtDay(evts: LifeEvent[], tz: string): string {
  if (evts.length === 0) return "";
  const key = dayKey(evts[0].timestamp, tz); // YYYY-MM-DD
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
