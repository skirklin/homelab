/**
 * Per-day entries popover, opened by tapping a tracker card's value badge.
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
 * sub-entries) — that's EventLogger's job. The set of entries on an event is
 * fixed at log-time by the manifest; editing changes their values.
 */
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { Popover, Button, TimePicker, InputNumber, Input, Switch, Segmented } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import type { LifeEvent, LifeEntry } from "@homelab/backend";
import { useFeedback, useLifeBackend } from "@kirkl/shared";

const EntryList = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  max-height: 280px;
  overflow-y: auto;
  min-width: 220px;
`;

const EntryRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-xs);
  border-radius: var(--radius-sm);

  &:hover {
    background: var(--color-bg-muted);
  }
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
  padding: var(--space-sm);
`;

interface EntriesPopoverProps {
  events: LifeEvent[];
  logId: string | undefined;
  children: React.ReactNode;
}

const DEBOUNCE_MS = 500;

export function EntriesPopover({ events, logId, children }: EntriesPopoverProps) {
  const life = useLifeBackend();
  const { message } = useFeedback();
  const [open, setOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (eventId: string) => {
    if (!logId) return;
    setDeletingId(eventId);
    try {
      await life.deleteEvent(eventId);
      if (events.length === 1) setOpen(false);
    } catch (err) {
      console.error("Failed to delete:", err);
      message.error("Failed to delete");
    } finally {
      setDeletingId(null);
    }
  };

  const content = events.length === 0 ? (
    <EmptyMessage>No entries</EmptyMessage>
  ) : (
    <EntryList>
      {events.map((event) => (
        <EditableEntryRow
          key={event.id}
          event={event}
          deleting={deletingId === event.id}
          onDelete={() => handleDelete(event.id)}
        />
      ))}
    </EntryList>
  );

  return (
    <Popover
      content={content}
      title="Entries"
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottom"
    >
      {children}
    </Popover>
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
    <EntryRow>
      <TopLine>
        <TimestampEditor event={event} />
        <DeleteButton
          type="text"
          danger
          size="small"
          icon={<DeleteOutlined />}
          loading={deleting}
          onClick={onDelete}
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

// Duration trackables (unit "min") display as hours when the stored minutes
// look like a value the user originally meant in hours: >= 60 and an exact
// multiple of 5. Same heuristic as EventLogger's `defaultDurationInputUnit`,
// adapted for an existing stored value rather than a manifest default.
function pickDurationDisplayUnit(minutes: number): "hours" | "minutes" {
  return minutes >= 60 && minutes % 5 === 0 ? "hours" : "minutes";
}

function EntryEditor({ event, index, entry }: EntryEditorProps) {
  // Local UI state mirrors the entry's value; resets to upstream on event
  // change (e.g. another tab edited it). Debounced commit for text/number;
  // bool commits immediately.
  //
  // Invariant: `local` for number entries is in canonical units (i.e. minutes
  // for unit="min"). The duration toggle is display-only — the InputNumber's
  // value is derived from `local` at render time, and edits are converted back
  // to canonical before being written to `local` / committed.
  const [local, setLocal] = useState<LifeEntry["value"]>(entry.value);
  const [saving, setSaving] = useState(false);
  const isDuration = entry.type === "number" && entry.unit === "min";
  const [durationUnit, setDurationUnit] = useState<"hours" | "minutes">(() =>
    isDuration ? pickDurationDisplayUnit(entry.value as number) : "minutes",
  );
  // Track upstream value so we know what to revert to on failure.
  const upstreamRef = useRef<LifeEntry["value"]>(entry.value);

  useEffect(() => {
    upstreamRef.current = entry.value;
    setLocal(entry.value);
    if (isDuration) {
      setDurationUnit(pickDurationDisplayUnit(entry.value as number));
    }
  }, [entry.value, isDuration]);

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
    if (isDuration) {
      // Stored canonical minutes; display in `durationUnit`.
      const storedMinutes = local as number;
      const displayed =
        durationUnit === "hours"
          ? Math.round((storedMinutes / 60) * 100) / 100
          : storedMinutes;
      return (
        <ValueLine>
          <EntryName>{entry.name}</EntryName>
          <InputNumber
            size="small"
            value={displayed}
            min={0}
            step={durationUnit === "hours" ? 0.5 : 1}
            onChange={(v) => {
              if (typeof v !== "number") return;
              const minutes =
                durationUnit === "hours" ? Math.round(v * 60) : v;
              setLocal(minutes);
              scheduleCommit(minutes);
            }}
            onBlur={() => {
              // Flush any pending debounce immediately on blur.
              if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
                void commit(local);
              }
            }}
            style={{ width: 80 }}
          />
          <Segmented
            size="small"
            options={[
              { label: "min", value: "minutes" },
              { label: "hr", value: "hours" },
            ]}
            value={durationUnit}
            onChange={(v) => setDurationUnit(v as "hours" | "minutes")}
          />
          {saving && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>…</span>}
        </ValueLine>
      );
    }
    return (
      <ValueLine>
        <EntryName>{entry.name}</EntryName>
        <InputNumber
          size="small"
          value={local as number}
          min={entry.unit === "rating" ? 1 : 0}
          max={entry.unit === "rating" ? entry.scale ?? 5 : undefined}
          onChange={(v) => {
            if (typeof v !== "number") return;
            setLocal(v);
            scheduleCommit(v);
          }}
          onBlur={() => {
            // Flush any pending debounce immediately on blur.
            if (debounceRef.current) {
              clearTimeout(debounceRef.current);
              debounceRef.current = null;
              void commit(local);
            }
          }}
          style={{ width: 80 }}
        />
        <EntryName style={{ minWidth: 0 }}>{entry.unit}</EntryName>
        {saving && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>…</span>}
      </ValueLine>
    );
  }

  // text
  return (
    <ValueLine style={{ width: "100%" }}>
      <EntryName>{entry.name}</EntryName>
      <Input
        size="small"
        value={local as string}
        onChange={(e) => {
          const v = e.target.value;
          setLocal(v);
          scheduleCommit(v);
        }}
        onBlur={() => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
            void commit(local);
          }
        }}
        style={{ flex: 1 }}
      />
      {saving && <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-muted)" }}>…</span>}
    </ValueLine>
  );
}
