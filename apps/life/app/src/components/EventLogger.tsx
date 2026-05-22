/**
 * Generic event logger card. One component replaces all bespoke widget
 * renderers. Behaviour is driven by the Trackable manifest entry:
 *
 *  - "ct" trackables with defaultValue=1 and no categories/intensity/notes
 *    are "one-tap" — clicking the card logs a single count entry. This is
 *    the old counter ergonomics for floss / poop / etc.
 *  - rating-shaped (unit: "rating") trackables show a 1-5 picker inline.
 *  - "min" duration trackables accept input as hours (sleep) or minutes
 *    (exercise/focus) based on defaultValue and convert to canonical
 *    minutes on write.
 *  - everything else expands an inline form with value (pre-filled from
 *    defaultValue), an optional category picker (written to labels),
 *    intensity rating, and a notes text entry.
 *
 * The card always shows the day's aggregated value (sum for non-rating
 * units, avg for rating units — see lib/format.ts `aggregationFor`) so the
 * dashboard reads at a glance. Tap the value badge to open an entries
 * popover (delete individual entries).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import styled, { css } from "styled-components";
import { Input, InputNumber, Button, Segmented } from "antd";
import { PlusOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import type { LifeEntry, LifeEvent } from "@homelab/backend";
import type { Trackable } from "../manifest";
import type { LogEntry } from "../types";
import { type WidgetSize } from "../display-settings";
import {
  aggregate,
  formatDuration,
  formatRating,
  formatDose,
  collectNumberValues,
  primaryEntryName,
} from "../lib/format";
import { EntriesPopover } from "./EntriesPopover";

interface EventLoggerProps {
  trackable: Trackable;
  /** All events for the log. */
  entries: LogEntry[];
  userId: string;
  logId: string | undefined;
  /** If set, log against this timestamp (for backfilling on past days). */
  timestamp?: Date;
  size?: WidgetSize;
}

const sizeStyles = {
  compact:    css`padding: var(--space-sm); gap: var(--space-xs);`,
  normal:     css`padding: var(--space-md); gap: var(--space-sm);`,
  comfortable:css`padding: var(--space-lg); gap: var(--space-sm);`,
};

const Card = styled.div<{ $size: WidgetSize; $highlighted: boolean }>`
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 2px solid ${(p) => (p.$highlighted ? "var(--color-primary)" : "var(--color-border)")};
  border-radius: var(--radius-lg);
  ${(p) => sizeStyles[p.$size]}
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
`;

const Label = styled.span<{ $size: WidgetSize }>`
  font-weight: 500;
  color: var(--color-text);
  font-size: ${(p) => (p.$size === "compact" ? "var(--font-size-sm)" : "var(--font-size-base)")};
`;

const ValueBadge = styled.button<{ $logged: boolean; $size: WidgetSize }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid ${(p) => (p.$logged ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$logged ? "var(--color-primary-light)" : "var(--color-bg)")};
  color: ${(p) => (p.$logged ? "var(--color-primary)" : "var(--color-text-secondary)")};
  border-radius: var(--radius-md);
  padding: 4px 10px;
  font-weight: 600;
  font-size: ${(p) => (p.$size === "compact" ? "var(--font-size-xs)" : "var(--font-size-sm)")};
  cursor: ${(p) => (p.$logged ? "pointer" : "default")};
`;

const Hint = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
`;

const FormRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
`;

const InlineRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
`;

const FieldLabel = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const CategoryGroup = styled.div`
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
`;

const CategoryChip = styled.button<{ $selected: boolean }>`
  border: 1px solid ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-bg)")};
  color: ${(p) => (p.$selected ? "white" : "var(--color-text)")};
  border-radius: 999px;
  padding: 2px 10px;
  font-size: var(--font-size-xs);
  cursor: pointer;
`;

const RatingRow = styled.div`
  display: flex;
  gap: 6px;
`;

const RatingNum = styled.button<{ $selected: boolean }>`
  flex: 1;
  min-width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-bg)")};
  color: ${(p) => (p.$selected ? "white" : "var(--color-text)")};
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
`;

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: var(--space-xs);
`;

const TapPlus = styled.button<{ $size: WidgetSize }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${(p) => (p.$size === "compact" ? "28px" : "32px")};
  height: ${(p) => (p.$size === "compact" ? "28px" : "32px")};
  border-radius: 50%;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  border: none;
  cursor: pointer;

  &:hover { background: var(--color-primary-light); color: var(--color-primary); }
`;

// ---------- Trackable mode detection ----------

function isOneTap(t: Trackable): boolean {
  return (
    t.unit === "ct" &&
    t.defaultValue === 1 &&
    !t.categories &&
    !t.hasIntensity &&
    !t.hasNotes
  );
}

function isRatingShaped(t: Trackable): boolean {
  return t.unit === "rating";
}

/** Duration trackables default to hours input when the default >= 60min. */
function defaultDurationInputUnit(t: Trackable): "hours" | "minutes" {
  if (t.unit !== "min") return "minutes";
  return (t.defaultValue ?? 0) >= 60 ? "hours" : "minutes";
}

// ---------- Per-day filtering / aggregation ----------

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

function eventsForTrackable(events: LogEntry[], trackableId: string, day?: Date): LifeEvent[] {
  const date = day ?? new Date();
  const dayStart = startOfDay(date);
  const dayEnd = endOfDay(date);
  return events
    .filter((e) => e.subjectId === trackableId && e.timestamp >= dayStart && e.timestamp <= dayEnd)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

function formatValueDisplay(value: number | null, trackable: Trackable): string {
  if (value === null) return "—";
  if (trackable.unit === "rating") return formatRating(value, 5);
  if (trackable.unit === "min") return formatDuration(value);
  return formatDose(value, trackable.unit);
}

function categoryBreakdown(events: LifeEvent[]): string | null {
  // Sum primary numeric entries per labels.category. Today this is only used
  // for exercise / focus, which both have a `categories` array on their
  // Trackable.
  const byCat: Record<string, number> = {};
  for (const ev of events) {
    const cat = ev.labels?.category;
    if (!cat) continue;
    // Primary entry: just walk numeric entries until one matches.
    // For combo trackables, the "duration" entry is the right one to bucket.
    for (const e of ev.entries) {
      if (e.type === "number" && e.name === "duration") {
        byCat[cat] = (byCat[cat] ?? 0) + e.value;
        break;
      }
    }
  }
  const parts = Object.entries(byCat);
  if (parts.length <= 1) return null;
  return parts.map(([cat, v]) => `${cat} ${v}`).join(" + ");
}

// ---------- Component ----------

export function EventLogger({ trackable, entries, userId, logId, timestamp, size = "normal" }: EventLoggerProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();

  const dayEvents = useMemo(
    () => eventsForTrackable(entries, trackable.id, timestamp),
    [entries, trackable.id, timestamp],
  );

  const primaryName = useMemo(() => primaryEntryName(trackable.id), [trackable.id]);
  const aggValues = useMemo(() => collectNumberValues(dayEvents, primaryName), [dayEvents, primaryName]);
  const agg = aggregate(aggValues, trackable.unit);

  const breakdown = trackable.categories ? categoryBreakdown(dayEvents) : null;
  const oneTap = isOneTap(trackable);
  const rating = isRatingShaped(trackable);
  const durationInputUnit = defaultDurationInputUnit(trackable);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // For duration trackables, `value` is held in the *input* unit (hours or
  // minutes); converted to canonical minutes at submit time.
  const initialInputValue =
    trackable.unit === "min" && durationInputUnit === "hours" && trackable.defaultValue !== undefined
      ? trackable.defaultValue / 60
      : (trackable.defaultValue ?? null);
  const [value, setValue] = useState<number | null>(initialInputValue);
  const [inputUnit, setInputUnit] = useState<"hours" | "minutes">(durationInputUnit);
  const [category, setCategory] = useState<string | undefined>(trackable.categories?.[0]);
  const [intensity, setIntensity] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  // Reset form state on open so each log starts fresh.
  useEffect(() => {
    if (open) {
      setValue(initialInputValue);
      setInputUnit(durationInputUnit);
      setCategory(trackable.categories?.[0]);
      setIntensity(null);
      setNotes("");
    }
  }, [open, trackable, initialInputValue, durationInputUnit]);

  const cancelEdit = useCallback(() => {
    setOpen(false);
  }, []);

  const writeEvent = useCallback(async (
    eventEntries: LifeEntry[],
    labels?: Record<string, string>,
  ) => {
    if (!logId || !userId) return;
    setSaving(true);
    try {
      await life.addEvent(logId, trackable.id, eventEntries, userId, {
        timestamp,
        labels,
      });
      setOpen(false);
    } catch (err) {
      console.error("Failed to log:", err);
      message.error("Failed to log");
    } finally {
      setSaving(false);
    }
  }, [logId, userId, trackable.id, timestamp, life, message]);

  // One-tap mode: clicking the card logs a single count entry immediately.
  const handleOneTap = useCallback(() => {
    if (!oneTap) return;
    writeEvent([
      { name: primaryName, type: "number", value: 1, unit: trackable.unit },
    ]);
  }, [oneTap, writeEvent, primaryName, trackable.unit]);

  // Rating-shaped: clicking a number logs immediately as one rating entry.
  const handleRatingClick = useCallback((n: number) => {
    writeEvent([
      { name: primaryName, type: "number", value: n, unit: "rating", scale: 5 },
    ]);
  }, [writeEvent, primaryName]);

  const handleSubmit = useCallback(() => {
    if (value === null) {
      message.warning("Enter a value");
      return;
    }
    // Convert hours→minutes for duration trackables when the input unit is hours.
    const storedValue =
      trackable.unit === "min" && inputUnit === "hours"
        ? Math.round(value * 60)
        : value;
    const eventEntries: LifeEntry[] = [
      { name: primaryName, type: "number", value: storedValue, unit: trackable.unit },
    ];
    if (intensity !== null) {
      eventEntries.push({ name: "intensity", type: "number", value: intensity, unit: "rating", scale: 5 });
    }
    if (notes.trim()) {
      eventEntries.push({ name: "notes", type: "text", value: notes.trim() });
    }
    const labels: Record<string, string> = {};
    if (category) labels.category = category;
    writeEvent(eventEntries, Object.keys(labels).length > 0 ? labels : undefined);
  }, [value, inputUnit, category, intensity, notes, trackable.unit, primaryName, writeEvent, message]);

  // Submit on Enter when in the form.
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = formRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        cancelEdit();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [open, handleSubmit, cancelEdit]);

  const headerLabel = (
    <Label $size={size}>{trackable.label}</Label>
  );

  // Value badge — clickable for entries popover when there's logged data.
  // The outer span swallows clicks so the popover trigger doesn't bubble up
  // to the Card's onClick in one-tap mode (which would log another entry).
  const valueDisplay = (
    <>
      {dayEvents.length > 0 ? (
        <span onClick={(e) => e.stopPropagation()}>
          <EntriesPopover events={dayEvents} logId={logId}>
            <ValueBadge $logged={true} $size={size} title={`${dayEvents.length} ${dayEvents.length === 1 ? "entry" : "entries"}`}>
              {formatValueDisplay(agg, trackable)}
              {dayEvents.length > 1 && <span>· {dayEvents.length}</span>}
            </ValueBadge>
          </EntriesPopover>
        </span>
      ) : (
        <ValueBadge $logged={false} $size={size} as="span">—</ValueBadge>
      )}
    </>
  );

  // --- Render ---

  // One-tap mode: the whole card is a button.
  if (oneTap) {
    return (
      <Card $size={size} $highlighted={dayEvents.length > 0} onClick={handleOneTap} style={{ cursor: "pointer" }}>
        <HeaderRow>
          {headerLabel}
          {dayEvents.length > 0 ? (
            valueDisplay
          ) : (
            <TapPlus $size={size} disabled={saving || !logId} aria-label="Log">
              <PlusOutlined />
            </TapPlus>
          )}
        </HeaderRow>
      </Card>
    );
  }

  // Rating mode: always-expanded numeric picker. No "open" state.
  if (rating) {
    const nums = [1, 2, 3, 4, 5];
    return (
      <Card $size={size} $highlighted={dayEvents.length > 0}>
        <HeaderRow>
          {headerLabel}
          {valueDisplay}
        </HeaderRow>
        <RatingRow style={{ marginTop: "var(--space-sm)" }}>
          {nums.map((n) => (
            <RatingNum
              key={n}
              $selected={false}
              onClick={() => handleRatingClick(n)}
              disabled={saving || !logId}
              aria-label={`Log ${n}`}
            >
              {n}
            </RatingNum>
          ))}
        </RatingRow>
      </Card>
    );
  }

  // Default mode: card collapsed → tap to open inline form.
  const showHoursToggle = trackable.unit === "min";
  return (
    <Card $size={size} $highlighted={dayEvents.length > 0}>
      <HeaderRow>
        {headerLabel}
        {!open && (
          <InlineRow>
            {valueDisplay}
            <TapPlus $size={size} onClick={() => setOpen(true)} aria-label="Log">
              <PlusOutlined />
            </TapPlus>
          </InlineRow>
        )}
      </HeaderRow>

      {open && (
        <FormRow ref={formRef}>
          <InlineRow>
            <FieldLabel style={{ minWidth: 60 }}>
              {showHoursToggle ? "Duration" : trackable.unit}
            </FieldLabel>
            <InputNumber
              value={value}
              onChange={(v) => setValue(typeof v === "number" ? v : null)}
              min={0}
              step={showHoursToggle && inputUnit === "hours" ? 0.5 : 1}
              autoFocus
              style={{ flex: 1 }}
              size={size === "compact" ? "small" : "middle"}
            />
            {showHoursToggle && (
              <Segmented
                size="small"
                options={[
                  { label: "h", value: "hours" },
                  { label: "m", value: "minutes" },
                ]}
                value={inputUnit}
                onChange={(v) => {
                  const next = v as "hours" | "minutes";
                  if (next === inputUnit) return;
                  // Convert the current value when the unit flips so the user
                  // doesn't have to retype.
                  if (value !== null) {
                    setValue(next === "hours" ? Math.round((value / 60) * 100) / 100 : Math.round(value * 60));
                  }
                  setInputUnit(next);
                }}
              />
            )}
          </InlineRow>

          {trackable.categories && (
            <div>
              <FieldLabel>Category</FieldLabel>
              <CategoryGroup>
                {trackable.categories.map((c) => (
                  <CategoryChip key={c} $selected={category === c} onClick={() => setCategory(c)}>
                    {c}
                  </CategoryChip>
                ))}
              </CategoryGroup>
            </div>
          )}

          {trackable.hasIntensity && (
            <div>
              <FieldLabel>Intensity</FieldLabel>
              <RatingRow>
                {[1, 2, 3, 4, 5].map((n) => (
                  <RatingNum key={n} $selected={intensity === n} onClick={() => setIntensity(intensity === n ? null : n)}>
                    {n}
                  </RatingNum>
                ))}
              </RatingRow>
            </div>
          )}

          {trackable.hasNotes && (
            <div>
              <FieldLabel>Notes</FieldLabel>
              <Input.TextArea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Optional"
              />
            </div>
          )}

          <Actions>
            <Button size="small" icon={<CloseOutlined />} onClick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={saving} onClick={handleSubmit}>
              Log
            </Button>
          </Actions>
          {dayEvents.length > 0 && (
            <Hint>{dayEvents.length} logged today{breakdown ? ` · ${breakdown}` : ""}</Hint>
          )}
        </FormRow>
      )}

      {!open && breakdown && <Hint style={{ marginTop: 4 }}>{breakdown}</Hint>}
    </Card>
  );
}
