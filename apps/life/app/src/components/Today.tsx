/**
 * Today — the REVIEW lens. The capture surface lives on Log (`/`); this screen
 * is where the user looks back at a day: a Timeline · Habits toggle swapping
 * DayTimeline ⇄ HabitBoard, plus the session completion grid. Shares the
 * viewed-day state machine with Log via `useSelectedDate` (the `?date=` URL
 * param), so the date-nav row and swipe stepping work here identically.
 */
import { useCallback, useMemo, useState } from "react";
import styled from "styled-components";
import { Segmented } from "antd";
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
import { SessionStreakGrid } from "./SessionStreakGrid";
import { useTrackables, useGoals } from "../lib/trackables";
import { userTz } from "../lib/useUserTz";

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
  const { selectedDate, dateParam } = date;

  const [openShape, setOpenShape] = useState<TrackableShape | null>(null);
  // When the Habits calendar backfills via the sheet, it passes the tapped day;
  // that overrides the viewed day so the sheet logs to the right bucket. Cleared
  // on close.
  const [shapeBackfillDay, setShapeBackfillDay] = useState<Date | null>(null);
  const openShapeForBackfill = useCallback((shape: TrackableShape, backfillDay?: Date) => {
    setShapeBackfillDay(backfillDay ?? null);
    setOpenShape(shape);
  }, []);
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
  const tz = userTz();

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
                onOpenShape={openShapeForBackfill}
              />
            )}
          </DateNav>
        </Section>

        <Section>
          <SectionTitle>Sessions</SectionTitle>
          <SessionStreakGrid entries={allEntries} tz={tz} />
        </Section>
      </PageContainer>

      <ShapeSheet
        shape={openShape}
        onClose={() => {
          setOpenShape(null);
          setShapeBackfillDay(null);
        }}
        trackables={trackables}
        events={allEntries}
        userId={user?.uid ?? ""}
        logId={state.log?.id}
        day={shapeBackfillDay ?? selectedDate}
      />
    </>
  );
}
