import styled from "styled-components";
import type { Activity } from "../types";
import { NotesThread } from "./NotesThread";
import { daySubjectId } from "./noteEntries";

// ── Activity-level reflection (verdict + per-user notes thread) ───

const ActivityReflectionRow = styled.div`
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed #f0f0f0;
`;

interface ActivityReflectionProps {
  activity: Activity;
}

/**
 * Per-activity reflection: the caller's verdict picker plus the stacked,
 * cross-visible notes thread. Replaces the old single-textarea + shared-scalar
 * verdict (Phase 4).
 */
export function ActivityReflection({ activity }: ActivityReflectionProps) {
  return (
    <ActivityReflectionRow onClick={(e) => e.stopPropagation()}>
      <NotesThread subjectType="activity" subjectId={activity.id} showVerdict title={activity.name} />
    </ActivityReflectionRow>
  );
}

// ── Day-level journal (per-user thread of text/highlight/mood) ───

const DayJournalRow = styled.div`
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #d6e4ff;
`;

interface DayJournalProps {
  tripId: string;
  date: string; // YYYY-MM-DD
}

export function DayJournal({ tripId, date }: DayJournalProps) {
  return (
    <DayJournalRow onClick={(e) => e.stopPropagation()}>
      <NotesThread
        subjectType="day"
        subjectId={daySubjectId(tripId, date)}
        title={`Journal · ${date}`}
      />
    </DayJournalRow>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

/** Whether a given day is reflection-eligible (in the past or today). */
export function isDayReflectable(dayDate: string | undefined, todayYmd: string): boolean {
  if (!dayDate) return true; // no explicit date → defer to caller's trip-level gate
  return dayDate <= todayYmd;
}
