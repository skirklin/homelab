/**
 * Today — the REVIEW lens. The capture surface lives on Log (`/`); this screen
 * is where the user looks back at a day: a Timeline · Habits toggle swapping
 * DayTimeline ⇄ HabitBoard, plus the session streak grid. Shares the viewed-day
 * state machine with Log via `useSelectedDate` (the `?date=` URL param), so the
 * date-nav row and swipe stepping work here identically.
 */
import { useCallback, useMemo, useState } from "react";
import styled from "styled-components";
import { Segmented } from "antd";
import { SunOutlined, MoonOutlined } from "@ant-design/icons";
import {
  useAuth,
  PageContainer,
  Section,
  SectionTitle,
  AppHeader,
  SyncDot,
  useWpbDebug,
} from "@kirkl/shared";
import type { TrackableShape } from "@homelab/backend";
import { useLifeContext } from "../life-context";
import { useSelectedDate } from "../lib/useSelectedDate";
import { DateNav } from "./DateNav";
import { DayTimeline } from "./DayTimeline";
import { HabitBoard } from "./HabitBoard";
import { ShapeSheet } from "./ShapeSheet";
import { SessionStreakGrid, computeStreaks } from "./SessionStreakGrid";
import { Hint } from "./Hint";
import { useTrackables, useGoals } from "../lib/trackables";

const LIFE_COLLECTIONS = ["life_logs", "life_events"] as const;

const TitleWithStatus = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const LensToggleRow = styled.div`
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-md);
`;

const StreakCard = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-xs);
`;

const StreakItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 110px;
`;

const StreakLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;

  .anticon {
    color: var(--color-primary);
  }
`;

const StreakValue = styled.div`
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
`;

// The review lens — Timeline (the just-shipped inline timeline) or Habits. The
// choice persists in localStorage. Default Timeline so the timeline isn't
// regressed for returning users.
type ReviewLens = "timeline" | "habits";
const LENS_STORAGE_KEY = "life:reviewLens";
function readStoredLens(): ReviewLens {
  if (typeof localStorage === "undefined") return "timeline";
  return localStorage.getItem(LENS_STORAGE_KEY) === "habits" ? "habits" : "timeline";
}

export function Today() {
  const { user } = useAuth();
  const { state } = useLifeContext();
  const wpbDebug = useWpbDebug();

  const date = useSelectedDate();
  const { selectedDate, dateParam, getSelectedTimestamp } = date;

  const [openShape, setOpenShape] = useState<TrackableShape | null>(null);
  const [reviewLens, setReviewLens] = useState<ReviewLens>(readStoredLens);
  const selectLens = useCallback((lens: ReviewLens) => {
    setReviewLens(lens);
    try {
      localStorage.setItem(LENS_STORAGE_KEY, lens);
    } catch {
      // ignore quota / disabled storage — the in-memory choice still applies
    }
  }, []);

  const allEntries = useMemo(() => Array.from(state.entries.values()), [state.entries]);
  const trackables = useTrackables();
  const goals = useGoals();

  // Map identity flips on each SET_ENTRIES dispatch, so state.entries is a
  // stable-enough dep for the streak recompute.
  const morningStreaks = useMemo(() => computeStreaks(allEntries, "morning"), [state.entries]);
  const eveningStreaks = useMemo(() => computeStreaks(allEntries, "evening"), [state.entries]);

  // Carry the current `?date=` through to Journal so the timeline's "jump to
  // journal" handoff keeps the day context.
  const dateQuerySuffix = dateParam ? `?date=${encodeURIComponent(dateParam)}` : "";
  const journalTarget = `/journal${dateQuerySuffix}`;

  return (
    <>
      <AppHeader
        title={
          <TitleWithStatus>
            Today
            <SyncDot debug={wpbDebug} collections={LIFE_COLLECTIONS} />
          </TitleWithStatus>
        }
      />

      <PageContainer>
        <Section>
          <DateNav date={date}>
            <LensToggleRow>
              <Segmented<ReviewLens>
                value={reviewLens}
                onChange={selectLens}
                options={[
                  { label: "Timeline", value: "timeline" },
                  { label: "Habits", value: "habits" },
                ]}
                data-testid="review-lens-toggle"
              />
            </LensToggleRow>
            {reviewLens === "timeline" ? (
              <DayTimeline
                trackables={trackables}
                events={allEntries}
                day={selectedDate}
                journalTarget={journalTarget}
              />
            ) : (
              <HabitBoard
                trackables={trackables}
                goals={goals}
                events={allEntries}
                day={selectedDate}
                userId={user?.uid ?? ""}
                logId={state.log?.id}
                timestamp={getSelectedTimestamp()}
                onOpenShape={setOpenShape}
              />
            )}
          </DateNav>
        </Section>

        <Section>
          <SectionTitle>Streaks</SectionTitle>
          <StreakCard>
            <StreakItem>
              <StreakLabel><SunOutlined /> Morning</StreakLabel>
              <StreakValue>
                {morningStreaks.current} {morningStreaks.current === 1 ? "day" : "days"}
                {morningStreaks.longest > morningStreaks.current && (
                  <Hint style={{ fontWeight: 400, marginLeft: 6 }}>best: {morningStreaks.longest}</Hint>
                )}
              </StreakValue>
            </StreakItem>
            <StreakItem>
              <StreakLabel><MoonOutlined /> Evening</StreakLabel>
              <StreakValue>
                {eveningStreaks.current} {eveningStreaks.current === 1 ? "day" : "days"}
                {eveningStreaks.longest > eveningStreaks.current && (
                  <Hint style={{ fontWeight: 400, marginLeft: 6 }}>best: {eveningStreaks.longest}</Hint>
                )}
              </StreakValue>
            </StreakItem>
          </StreakCard>
          <SessionStreakGrid entries={allEntries} />
        </Section>
      </PageContainer>

      <ShapeSheet
        shape={openShape}
        onClose={() => setOpenShape(null)}
        trackables={trackables}
        events={allEntries}
        userId={user?.uid ?? ""}
        logId={state.log?.id}
        day={selectedDate}
      />
    </>
  );
}
