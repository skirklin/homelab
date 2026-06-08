/**
 * The per-user, cross-visible notes thread. Notes are independent entries: a
 * user may leave MULTIPLE notes on the same subject. Everyone sees everyone's;
 * you edit/delete only your own (by id). Reused across all three reflection
 * surfaces (activity / day / trip) — one shared component beats three bespoke.
 *
 * A rating (verdict) is an OPTIONAL field composed inside a note, for activity
 * subjects only — there is no standalone tap-to-rate and no single "your
 * reaction" card. Adding always CREATES a new note; a fully-empty compose (no
 * rating AND no text/highlight/mood) is rejected.
 *
 * Data is read ONLY from `travel_notes` state (legacy columns are the Phase-5
 * safety net, never a second display source).
 */
import { useMemo, useState } from "react";
import { Button, Input, Popconfirm, Rate } from "antd";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth, useTravelBackend, useUserNames, useFeedback } from "@kirkl/shared";
import { useTravelContext } from "../travel-context";
import type { ActivityVerdict, LifeEntry, TravelNote } from "../types";
import { VerdictButtons } from "./VerdictButtons";
import {
  type SubjectType,
  type DayFields,
  selectNotes,
  isImported,
  verdictOf,
  activityNotesText,
  activityEntries,
  dayFieldsOf,
  dayEntries,
  tripNotesText,
  tripEntries,
  isEmptyEntries,
} from "./noteEntries";

const VERDICT_LABEL: Record<ActivityVerdict, string> = {
  loved: "loved",
  liked: "liked",
  meh: "meh",
  skip: "would skip",
};

// ── styling ──────────────────────────────────────────────────────

const Thread = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const NoteCard = styled.div<{ $own: boolean }>`
  border: 1px solid ${(p) => (p.$own ? "#bae0ff" : "#f0f0f0")};
  background: ${(p) => (p.$own ? "#f0f7ff" : "#fafafa")};
  border-radius: 8px;
  padding: 8px 10px;
`;

const NoteHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
`;

const Author = styled.span<{ $muted?: boolean }>`
  font-size: 12px;
  font-weight: 600;
  color: ${(p) => (p.$muted ? "#bfbfbf" : "#1677ff")};
  font-style: ${(p) => (p.$muted ? "italic" : "normal")};
`;

const VerdictTag = styled.span`
  font-size: 12px;
  color: #595959;
  margin-left: 6px;
  font-weight: 400;
`;

const VerdictRow = styled.div`
  margin: 2px 0 4px;
`;

const NoteText = styled.div`
  font-size: 13px;
  color: #262626;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
`;

const HighlightText = styled(NoteText)`
  font-style: italic;
  color: #ad6800;
`;

const Actions = styled.div`
  display: flex;
  gap: 2px;
  flex-shrink: 0;
`;

const AddRow = styled.button`
  align-self: flex-start;
  background: none;
  border: 1px dashed #d9d9d9;
  border-radius: 6px;
  color: #8c8c8c;
  cursor: pointer;
  font-size: 12px;
  padding: 6px 10px;
  &:hover {
    color: #1677ff;
    border-color: #91caff;
  }
`;

const Label = styled.div`
  font-size: 10px;
  font-weight: 600;
  color: #8c8c8c;
  letter-spacing: 0.4px;
  margin: 6px 0 2px;
`;

interface Props {
  subjectType: SubjectType;
  /** activity→activity id, trip→trip id, day→`"${tripId}:${date}"`. */
  subjectId: string;
  /** Show the optional rating picker in activity composers/editors. */
  showVerdict?: boolean;
}

export function NotesThread({ subjectType, subjectId, showVerdict }: Props) {
  const { user } = useAuth();
  const travel = useTravelBackend();
  const { message } = useFeedback();
  const { state } = useTravelContext();
  const logId = state.log?.id ?? "";
  const myId = user?.uid;

  const notes = useMemo(
    () => selectNotes(state.notes.values(), subjectType, subjectId),
    [state.notes, subjectType, subjectId],
  );

  const names = useUserNames(notes.map((n) => n.createdBy));

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // The rating field is offered only for activity subjects when enabled.
  const ratingEnabled = !!showVerdict && subjectType === "activity";

  const entriesFor = (draft: NoteDraft): LifeEntry[] => {
    if (subjectType === "activity") return activityEntries(draft.verdict ?? null, draft.text);
    if (subjectType === "trip") return tripEntries(draft.text);
    return dayEntries({ text: draft.text, highlight: draft.highlight, mood: draft.mood });
  };

  // Add ALWAYS creates a new note. An all-empty compose is rejected — nothing
  // is created (the editor's Save is also disabled, this is the backstop).
  const addNewNote = async (draft: NoteDraft) => {
    const entries = entriesFor(draft);
    if (isEmptyEntries(entries) || !myId) {
      setAdding(false);
      return;
    }
    try {
      await travel.addNote(logId, subjectType, subjectId, myId, entries);
    } catch {
      message.error("Couldn't save your note");
    }
    setAdding(false);
  };

  // Edit updates exactly THAT note id. An emptied note is deleted.
  const saveEdit = async (noteId: string, draft: NoteDraft) => {
    const entries = entriesFor(draft);
    try {
      if (isEmptyEntries(entries)) await travel.deleteNote(noteId);
      else await travel.updateNote(noteId, entries);
    } catch {
      message.error("Couldn't save your note");
    }
    setEditingId(null);
  };

  const remove = async (noteId: string) => {
    try {
      await travel.deleteNote(noteId);
    } catch {
      message.error("Couldn't delete your note");
    }
  };

  return (
    <Thread onClick={(e) => e.stopPropagation()}>
      {notes.map((note) => {
        const imported = isImported(note);
        // `myId===undefined` (auth not loaded) must never make a note "own";
        // an imported (createdBy==="") note is never own either.
        const own = note.createdBy === myId && !imported;
        const authorName = imported ? "Imported" : names.get(note.createdBy) || "Someone";
        const editing = editingId === note.id;
        const verdict = verdictOf(note);

        return (
          <NoteCard key={note.id} $own={own} data-testid={`note-${note.id}`}>
            <NoteHead>
              <Author $muted={imported}>
                {authorName}
                {/* Others'/imported ratings are read-only text tags. */}
                {subjectType === "activity" && verdict && (
                  <VerdictTag>· {VERDICT_LABEL[verdict]}</VerdictTag>
                )}
              </Author>
              {own && !editing && (
                <Actions>
                  <Button
                    type="text"
                    size="small"
                    data-testid="note-edit"
                    icon={<EditOutlined />}
                    onClick={() => setEditingId(note.id)}
                  />
                  <Popconfirm title="Delete this note?" onConfirm={() => remove(note.id)} okText="Delete">
                    <Button type="text" size="small" danger data-testid="note-delete" icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Actions>
              )}
            </NoteHead>

            {editing ? (
              <NoteEditor
                subjectType={subjectType}
                ratingEnabled={ratingEnabled}
                initial={draftFromNote(subjectType, note)}
                onCancel={() => setEditingId(null)}
                onSave={(draft) => saveEdit(note.id, draft)}
              />
            ) : (
              <NoteBody subjectType={subjectType} note={note} />
            )}
          </NoteCard>
        );
      })}

      {/* "Add a note" is ALWAYS available to the caller — never gated on
          having zero notes. Each add creates a new, independent note. */}
      {adding ? (
        <NoteCard $own data-testid="note-add-editor">
          <NoteEditor
            subjectType={subjectType}
            ratingEnabled={ratingEnabled}
            initial={emptyDraft()}
            autoFocus
            onCancel={() => setAdding(false)}
            onSave={addNewNote}
          />
        </NoteCard>
      ) : (
        <AddRow type="button" data-testid="note-add" onClick={() => setAdding(true)}>
          + add {subjectLabel(subjectType)}
        </AddRow>
      )}
    </Thread>
  );
}

function subjectLabel(t: SubjectType): string {
  return t === "day" ? "a journal entry" : "a note";
}

// ── read-only body ───────────────────────────────────────────────

function NoteBody({ subjectType, note }: { subjectType: SubjectType; note: TravelNote }) {
  if (subjectType === "day") {
    const f = dayFieldsOf(note);
    return (
      <>
        {f.highlight && <HighlightText>“{f.highlight}”</HighlightText>}
        {f.text && <NoteText>{f.text}</NoteText>}
        {f.mood != null && (
          <div style={{ marginTop: 2 }}>
            <Rate disabled value={f.mood} style={{ fontSize: 13 }} />
          </div>
        )}
      </>
    );
  }
  const text = subjectType === "activity" ? activityNotesText(note) : tripNotesText(note);
  return text ? <NoteText>{text}</NoteText> : null;
}

// ── editor ───────────────────────────────────────────────────────

interface NoteDraft {
  text: string;
  highlight: string;
  mood: number | null;
  /** Optional rating, activity subjects only. */
  verdict: ActivityVerdict | null;
}

function emptyDraft(): NoteDraft {
  return { text: "", highlight: "", mood: null, verdict: null };
}

function draftFromNote(subjectType: SubjectType, note: TravelNote): NoteDraft {
  if (subjectType === "day") {
    const f: DayFields = dayFieldsOf(note);
    return { text: f.text, highlight: f.highlight, mood: f.mood, verdict: null };
  }
  const text = subjectType === "activity" ? activityNotesText(note) : tripNotesText(note);
  return { text, highlight: "", mood: null, verdict: verdictOf(note) ?? null };
}

function NoteEditor({
  subjectType,
  ratingEnabled,
  initial,
  autoFocus,
  onSave,
  onCancel,
}: {
  subjectType: SubjectType;
  ratingEnabled: boolean;
  initial: NoteDraft;
  autoFocus?: boolean;
  onSave: (draft: NoteDraft) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<NoteDraft>(initial);
  const [saving, setSaving] = useState(false);

  // Block a fully-empty note: no rating AND no text/highlight/mood. Disabling
  // Save is the affordance; the handler re-checks as a backstop.
  const empty =
    !draft.text.trim() &&
    !draft.highlight.trim() &&
    draft.mood == null &&
    draft.verdict == null;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {ratingEnabled && (
        <VerdictRow>
          <VerdictButtons
            current={draft.verdict ?? undefined}
            onSet={(v) => setDraft((d) => ({ ...d, verdict: v }))}
          />
        </VerdictRow>
      )}
      {subjectType === "day" && (
        <>
          <Input
            placeholder="Best moment of the day…"
            value={draft.highlight}
            onChange={(e) => setDraft((d) => ({ ...d, highlight: e.target.value }))}
            maxLength={500}
            size="small"
          />
          <Label>HOW WAS THE DAY?</Label>
          <Rate
            value={draft.mood ?? 0}
            onChange={(v) => setDraft((d) => ({ ...d, mood: v || null }))}
            style={{ fontSize: 18 }}
          />
        </>
      )}
      <Input.TextArea
        autoFocus={autoFocus}
        placeholder={
          subjectType === "day"
            ? "What happened? How did it feel? What surprised you?"
            : subjectType === "trip"
              ? "Your notes for this trip…"
              : "Notes for next time…"
        }
        autoSize={{ minRows: 2, maxRows: 10 }}
        value={draft.text}
        onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        maxLength={20000}
        style={{ fontSize: 13 }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <Button type="primary" size="small" loading={saving} disabled={empty} onClick={save}>
          Save
        </Button>
        <Button size="small" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
