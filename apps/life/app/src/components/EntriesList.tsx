/**
 * Inline-editable list of logged events (one row per event), used inside the
 * shape bottom-sheet to show "today's entries for the chosen thing" with
 * edit + delete. Adapted from the old EntriesPopover machinery — the popover
 * wrapper died with the per-trackable cards; the row editors live on.
 *
 * Each row inline-edits one logged event:
 *   - TimePicker for the event's timestamp (commits on change).
 *   - One editor per LifeEntry value (text/number/bool), debounced 500ms for
 *     text+number (avoid spamming PB on every keystroke); bool commits
 *     immediately.
 *   - Delete button.
 *
 * On save error we revert the row's UI state to the last known good value and
 * surface a toast. We never restructure the entries array (no add/remove of
 * sub-entries) — the set of entries on an event is fixed at log-time by its
 * shape; editing changes their values. Mis-taps are handled by delete here
 * plus the post-log Undo toast.
 */
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { Button, TimePicker, Switch } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import type { LifeEvent, LifeEntry } from "@homelab/backend";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import { NumberFieldEditor, DurationFieldEditor, TextFieldEditor } from "./EntryFields";

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const EntryRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-xs);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
`;

const TopLine = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
`;

const ValueLine = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
`;

const EntryName = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  min-width: 50px;
`;

const DeleteButton = styled(Button)`
  padding: 2px 6px;
  height: auto;
  min-width: auto;
`;

const EmptyMessage = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  padding: var(--space-xs) 0;
`;

const DEBOUNCE_MS = 500;

interface EntriesListProps {
  events: LifeEvent[];
  /** Rendered when events is empty; pass null to render nothing. */
  emptyText?: string | null;
  /**
   * Fired after an event is successfully deleted. Optional + backward-compatible
   * — the ShapeSheet usage omits it. The single-event EventEditModal wires it to
   * close itself (deleting the only row leaves nothing to edit).
   */
  onDeleted?: (eventId: string) => void;
}

export function EntriesList({ events, emptyText = "Nothing logged yet", onDeleted }: EntriesListProps) {
  const life = useLifeBackend();
  const { message } = useFeedback();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (eventId: string) => {
    setDeletingId(eventId);
    try {
      await life.deleteEvent(eventId);
      onDeleted?.(eventId);
    } catch (err) {
      console.error("Failed to delete:", err);
      message.error("Failed to delete");
    } finally {
      setDeletingId(null);
    }
  };

  if (events.length === 0) {
    return emptyText ? <EmptyMessage>{emptyText}</EmptyMessage> : null;
  }

  return (
    <List>
      {events.map((event) => (
        <EditableEntryRow
          key={event.id}
          event={event}
          deleting={deletingId === event.id}
          onDelete={() => handleDelete(event.id)}
        />
      ))}
    </List>
  );
}

// ---------- Row ----------

interface EditableEntryRowProps {
  event: LifeEvent;
  deleting: boolean;
  onDelete: () => void;
}

function EditableEntryRow({ event, deleting, onDelete }: EditableEntryRowProps) {
  return (
    <EntryRow data-testid="entry-row">
      <TopLine>
        <TimestampEditor event={event} />
        <DeleteButton
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          loading={deleting}
          onClick={onDelete}
          aria-label="Delete entry"
        />
      </TopLine>
      {event.entries.length > 0 && (
        <ValueLine>
          {event.entries.map((entry, idx) => (
            <EntryEditor
              key={`${event.id}-${idx}`}
              event={event}
              index={idx}
              entry={entry}
            />
          ))}
        </ValueLine>
      )}
    </EntryRow>
  );
}

// ---------- Timestamp editor (commits immediately) ----------

function TimestampEditor({ event }: { event: LifeEvent }) {
  const life = useLifeBackend();
  const { message } = useFeedback();
  // The TimePicker is uncontrolled-ish: it reflects whatever the upstream
  // event currently says. Optimistic mutations update event.timestamp via the
  // subscription, so `value` will track.
  const value = dayjs(event.timestamp);

  const onChange = async (next: Dayjs | null) => {
    if (!next) return; // TimePicker isn't clearable in this surface
    // Preserve the date; only swap H/M/S.
    const merged = dayjs(event.timestamp)
      .hour(next.hour())
      .minute(next.minute())
      .second(0)
      .millisecond(0);
    const newDate = merged.toDate();
    if (newDate.getTime() === event.timestamp.getTime()) return;
    try {
      await life.updateEvent(event.id, { timestamp: newDate });
    } catch (err) {
      console.error("Failed to update timestamp:", err);
      message.error("Failed to update time");
    }
  };

  return (
    <TimePicker
      value={value}
      onChange={onChange}
      format="h:mm A"
      use12Hours
      minuteStep={1}
      allowClear={false}
      size="small"
      style={{ width: 110 }}
    />
  );
}

// ---------- Entry value editor (per LifeEntry) ----------

interface EntryEditorProps {
  event: LifeEvent;
  index: number;
  entry: LifeEntry;
}

function EntryEditor({ event, index, entry }: EntryEditorProps) {
  // Local UI state mirrors the entry's value; resets to upstream on event
  // change (e.g. another tab edited it). Debounced commit for text/number;
  // bool commits immediately.
  //
  // Invariant: `local` for number entries is in canonical units (i.e. minutes
  // for unit="min"). The shared DurationFieldEditor owns the display-unit
  // toggle internally and surfaces canonical minutes via its onChange.
  const [local, setLocal] = useState<LifeEntry["value"]>(entry.value);
  const [saving, setSaving] = useState(false);
  // Track upstream value so we know what to revert to on failure.
  const upstreamRef = useRef<LifeEntry["value"]>(entry.value);

  useEffect(() => {
    upstreamRef.current = entry.value;
    setLocal(entry.value);
  }, [entry.value]);

  const life = useLifeBackend();
  const { message } = useFeedback();

  const commit = async (next: LifeEntry["value"]) => {
    if (next === upstreamRef.current) return;
    const newEntries: LifeEntry[] = event.entries.map((e, i) => {
      if (i !== index) return e;
      // Re-spread to keep unit/scale on number entries.
      return { ...e, value: next } as LifeEntry;
    });
    setSaving(true);
    try {
      await life.updateEvent(event.id, { entries: newEntries });
      upstreamRef.current = next;
    } catch (err) {
      console.error("Failed to update entry:", err);
      message.error("Failed to update");
      setLocal(upstreamRef.current);
    } finally {
      setSaving(false);
    }
  };

  // Debounce commit for text/number; cancel any pending on unmount or when
  // the value stabilises.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCommit = (next: LifeEntry["value"]) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void commit(next);
    }, DEBOUNCE_MS);
  };
  const flushPending = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
      void commit(local);
    }
  };
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  if (entry.type === "bool") {
    return (
      <ValueLine>
        <EntryName>{entry.name}</EntryName>
        <Switch
          size="small"
          checked={local as boolean}
          loading={saving}
          onChange={(checked) => {
            setLocal(checked);
            void commit(checked);
          }}
        />
      </ValueLine>
    );
  }

  if (entry.type === "number") {
    const isDuration = entry.unit === "min";
    if (isDuration) {
      return (
        <ValueLine>
          <EntryName>{entry.name}</EntryName>
          <DurationFieldEditor
            label=""
            minutes={local as number}
            onChange={(minutes) => {
              // Clearing the field (null) commits as 0 rather than silently
              // reverting on blur. LifeEntry's value is `number`, not nullable,
              // so 0 is the honest representation of "user emptied this".
              const next = minutes ?? 0;
              setLocal(next);
              scheduleCommit(next);
            }}
            onBlur={flushPending}
            saving={saving}
          />
        </ValueLine>
      );
    }
    return (
      <ValueLine>
        <EntryName>{entry.name}</EntryName>
        <NumberFieldEditor
          label=""
          value={local as number}
          min={entry.unit === "rating" ? 1 : 0}
          max={entry.unit === "rating" ? entry.scale ?? 5 : undefined}
          unit={entry.unit}
          onChange={(v) => {
            // Clearing the field (null) commits as 0 rather than silently
            // reverting on blur. See DurationFieldEditor case above for why.
            const next = v ?? 0;
            setLocal(next);
            scheduleCommit(next);
          }}
          onBlur={flushPending}
          saving={saving}
        />
      </ValueLine>
    );
  }

  // text
  return (
    <ValueLine style={{ width: "100%" }}>
      <EntryName>{entry.name}</EntryName>
      <TextFieldEditor
        label=""
        value={local as string}
        onChange={(v) => {
          setLocal(v);
          scheduleCommit(v);
        }}
        onBlur={flushPending}
        saving={saving}
      />
    </ValueLine>
  );
}
