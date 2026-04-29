import { useEffect, useMemo, useState } from "react";
import { Input } from "antd";
import styled from "styled-components";
import { useTravelBackend } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import { activityUpdatesToBackend } from "../adapters";
import type { Activity } from "../types";
import { VerdictButtons } from "./VerdictButtons";

// ── Activity-level reflection (verdict + personal notes) ─────────

const ActivityReflectionRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed #f0f0f0;
`;

const NotesPlaceholder = styled.span`
  font-size: 11px;
  color: #bfbfbf;
  font-style: italic;
`;

interface ActivityReflectionProps {
  activity: Activity;
  /** Compact = single-line note input only when expanded; full = always-visible textarea. */
  variant?: "compact" | "full";
}

export function ActivityReflection({ activity, variant = "full" }: ActivityReflectionProps) {
  const travel = useTravelBackend();
  const [draft, setDraft] = useState(activity.personalNotes ?? "");
  const [editing, setEditing] = useState(false);

  // Subscription updates push new notes in; sync local draft when not editing.
  useEffect(() => {
    if (!editing) setDraft(activity.personalNotes ?? "");
  }, [activity.personalNotes, editing]);

  const saveNotes = () => {
    const next = draft.trim();
    const current = (activity.personalNotes ?? "").trim();
    if (next === current) return;
    travel.updateActivity(
      activity.id,
      activityUpdatesToBackend({ personalNotes: next }),
    );
  };

  const showInput = variant === "full" || editing || !!draft;

  return (
    <ActivityReflectionRow onClick={(e) => e.stopPropagation()}>
      <VerdictButtons activityId={activity.id} current={activity.verdict} />
      {showInput ? (
        <Input.TextArea
          autoSize={{ minRows: 1, maxRows: 6 }}
          placeholder="Notes for next time…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            saveNotes();
          }}
          maxLength={5000}
          style={{ fontSize: 12 }}
        />
      ) : (
        <NotesPlaceholder
          onClick={() => setEditing(true)}
          style={{ cursor: "text" }}
        >
          + add a note
        </NotesPlaceholder>
      )}
    </ActivityReflectionRow>
  );
}

// ── Day-level journal (highlight + free-form text) ───────────────

const DayJournalCard = styled.div`
  margin-top: 12px;
  padding: 10px 12px;
  border-top: 1px solid #d6e4ff;
  background: #fafcff;
  border-radius: 0 0 6px 6px;
`;

const DayJournalLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: #1677ff;
  letter-spacing: 0.4px;
  margin-bottom: 6px;
`;

interface DayJournalProps {
  tripId: string;
  logId: string;
  date: string; // YYYY-MM-DD
}

export function DayJournal({ tripId, logId, date }: DayJournalProps) {
  const travel = useTravelBackend();
  const { state } = useTravelContext();

  const entry = useMemo(
    () =>
      Array.from(state.dayEntries.values()).find(
        (e) => e.tripId === tripId && e.date === date,
      ),
    [state.dayEntries, tripId, date],
  );

  const [highlight, setHighlight] = useState(entry?.highlight ?? "");
  const [text, setText] = useState(entry?.text ?? "");
  const [editingHighlight, setEditingHighlight] = useState(false);
  const [editingText, setEditingText] = useState(false);

  // Sync from subscription when not actively editing.
  useEffect(() => {
    if (!editingHighlight) setHighlight(entry?.highlight ?? "");
  }, [entry?.highlight, editingHighlight]);
  useEffect(() => {
    if (!editingText) setText(entry?.text ?? "");
  }, [entry?.text, editingText]);

  const persist = (fields: { highlight?: string; text?: string }) => {
    travel.upsertDayEntry(logId, tripId, date, fields);
  };

  return (
    <DayJournalCard onClick={(e) => e.stopPropagation()}>
      <DayJournalLabel>JOURNAL</DayJournalLabel>
      <Input
        placeholder="Best moment of the day…"
        value={highlight}
        onChange={(e) => setHighlight(e.target.value)}
        onFocus={() => setEditingHighlight(true)}
        onBlur={() => {
          setEditingHighlight(false);
          if ((entry?.highlight ?? "") !== highlight) persist({ highlight });
        }}
        maxLength={500}
        size="small"
      />
      <Input.TextArea
        placeholder="What happened? How did it feel? What surprised you?"
        autoSize={{ minRows: 2, maxRows: 10 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setEditingText(true)}
        onBlur={() => {
          setEditingText(false);
          if ((entry?.text ?? "") !== text) persist({ text });
        }}
        maxLength={20000}
        style={{ marginTop: 6, fontSize: 12 }}
      />
    </DayJournalCard>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

/** Whether a given day is reflection-eligible (in the past or today). */
export function isDayReflectable(dayDate: string | undefined, todayYmd: string): boolean {
  if (!dayDate) return true; // no explicit date → defer to caller's trip-level gate
  return dayDate <= todayYmd;
}
