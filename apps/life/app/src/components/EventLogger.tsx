/**
 * Generic event logger card. One component renders every trackable by looping
 * over its `fields[]` (P2) — no per-widget branching, no hardcoded ids.
 *
 * Each field renders an editor by `field.type`:
 *   - number   → numeric stepper (durations get an hours/minutes toggle)
 *   - rating   → 1..scale buttons
 *   - text     → textarea
 *   - category → chip group (written to labels[field.key])
 *   - bool     → checkbox
 *
 * Fast paths derived from the fields shape (not ids):
 *   - a single number field defaulting to 1 (a count) → one-tap card: tapping
 *     the card logs `value: 1` immediately.
 *   - a single bool field → one-tap card: tapping logs `true`.
 *   - a single rating field → inline 1..scale picker, logs on tap.
 *   - everything else → an inline form opened from the "+".
 *
 * Write path (matches the historical life_events shape so existing data and
 * `aggregationFor` keep working):
 *   - number/rating/text/bool fields → one `entries[]` item, `name = field.key`.
 *     Ratings write `{type:"number", value, unit:"rating", scale}`.
 *   - category fields → `labels[field.key] = value`.
 *
 * The card shows the day's aggregated PRIMARY value (sum for non-rating units,
 * avg for ratings — see lib/format.ts `aggregationFor`). Tap the value badge to
 * open the entries popover (delete individual entries).
 */
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import styled, { css } from "styled-components";
import { Button, Checkbox } from "antd";
import { PlusOutlined, CheckOutlined, CloseOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import type { LifeEntry, LifeEvent, LifeManifestTrackable, TypedField, QuickPayload } from "@homelab/backend";
import type { LogEntry } from "../types";
import { type WidgetSize } from "../display-settings";
import {
  aggregate,
  formatDuration,
  formatRating,
  formatDose,
  formatEntry,
  collectNumberValues,
} from "../lib/format";
import { primaryField, fieldUnit } from "../lib/trackables";
import { frecentPayloads, payloadKey } from "../lib/frecency";
import { EntriesPopover } from "./EntriesPopover";
import { NumberFieldEditor, DurationFieldEditor, TextFieldEditor } from "./EntryFields";
import { Hint } from "./Hint";

/** How many quick-action chips to show on a card (pins + frecency combined). */
const MAX_CHIPS = 4;

interface EventLoggerProps {
  trackable: LifeManifestTrackable;
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
  gap: var(--space-xs);
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
  transition: background-color 120ms ease, box-shadow 120ms ease;

  ${(p) => p.$logged && `
    &:hover {
      background: var(--color-primary);
      color: white;
    }
  `}
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
  /* min-width: 0 lets flex shrink the buttons below their content width so
     the buttons + gaps always fit a narrow card. Height is locked; width
     adapts. */
  min-width: 0;
  height: 32px;
  padding: 0;
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

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: var(--space-xs);
`;

const QuickChip = styled.div<{ $pinned: boolean }>`
  display: inline-flex;
  align-items: center;
  border: 1px solid ${(p) => (p.$pinned ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$pinned ? "var(--color-primary-light)" : "var(--color-bg)")};
  border-radius: 999px;
  overflow: hidden;
`;

/** The tap-to-log part of a chip. */
const ChipLog = styled.button<{ $pinned: boolean }>`
  border: none;
  background: transparent;
  color: ${(p) => (p.$pinned ? "var(--color-primary)" : "var(--color-text)")};
  padding: 2px 6px 2px 10px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  cursor: pointer;

  &:hover { color: var(--color-primary); }
`;

/** The star (pin/unpin) part of a chip. */
const ChipStar = styled.button<{ $pinned: boolean }>`
  border: none;
  background: transparent;
  color: ${(p) => (p.$pinned ? "var(--color-primary)" : "var(--color-text-secondary)")};
  padding: 2px 8px 2px 2px;
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;

  &:hover { color: var(--color-primary); }
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

// ---------- Field-shape helpers (no ids) ----------

/** A "count" number field: integer count whose natural one-tap value is 1. */
function isCountField(f: TypedField): boolean {
  return f.type === "number" && (f.unit === undefined || f.unit === "ct");
}

/** One-tap card: a single non-category field that logs a fixed value on tap. */
function oneTapKind(t: LifeManifestTrackable): "count" | "bool" | null {
  const fields = t.fields.filter((f) => f.type !== "category");
  if (fields.length !== 1) return null;
  const f = fields[0];
  if (f.type === "bool") return "bool";
  if (isCountField(f) && (f.defaultValue ?? 1) === 1) return "count";
  return null;
}

/** Rating-shaped: a single rating field, picker inline. */
function isRatingShaped(t: LifeManifestTrackable): boolean {
  const fields = t.fields.filter((f) => f.type !== "category");
  return fields.length === 1 && fields[0].type === "rating";
}

/** Duration fields render the hours/minutes toggle. */
function defaultDurationInputUnit(f: TypedField): "hours" | "minutes" {
  return (f.defaultValue ?? 0) >= 60 ? "hours" : "minutes";
}

/** Phone keyboard hint for a numeric field. */
function inputModeFor(f: TypedField): "decimal" | "numeric" {
  return f.unit === "ct" || f.unit === "drinks" || f.unit === undefined ? "numeric" : "decimal";
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

function formatValueDisplay(value: number | null, unit: string): string {
  if (value === null) return "—";
  if (unit === "rating") return formatRating(value, 5);
  if (unit === "min") return formatDuration(value);
  return formatDose(value, unit);
}

/**
 * A short human label for a quick-action chip. Uses the payload's explicit
 * `label` (pins carry one), else renders the primary number entry, appending
 * a category if present ("30m · run").
 */
function chipLabel(payload: QuickPayload): string {
  if (payload.label) return payload.label;
  const measured = payload.entries.filter((e) => e.type === "number" || e.type === "bool");
  const valuePart = measured.map(formatEntry).join(" ");
  const cat = payload.labels ? Object.values(payload.labels)[0] : undefined;
  return cat ? `${valuePart} · ${cat}` : valuePart;
}

/**
 * Sum the primary numeric value per category, for multi-category trackables.
 * Reads `labels[catKey]` and the primary field's numeric entry. Returns null
 * when there's only one (or no) category bucket — nothing to break down.
 */
function categoryBreakdown(events: LifeEvent[], catKey: string, primaryName: string): string | null {
  const byCat: Record<string, number> = {};
  for (const ev of events) {
    const cat = ev.labels?.[catKey];
    if (!cat) continue;
    for (const e of ev.entries) {
      if (e.type === "number" && e.name === primaryName) {
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

  // The headline number comes from the primary measurement field.
  const primary = useMemo(() => primaryField(trackable), [trackable]);
  const primaryName = primary?.key ?? "count";
  const primaryUnit = fieldUnit(primary);
  const aggValues = useMemo(() => collectNumberValues(dayEvents, primaryName), [dayEvents, primaryName]);
  const agg = aggregate(aggValues, primaryUnit);

  const categoryField = useMemo(() => trackable.fields.find((f) => f.type === "category"), [trackable]);
  const breakdown = categoryField
    ? categoryBreakdown(dayEvents, categoryField.key, primaryName)
    : null;

  const oneTap = oneTapKind(trackable);
  const rating = isRatingShaped(trackable);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Per-field form state. Numbers (incl. durations, in canonical units) live in
  // `numbers`, categories in `categories`, text in `texts`, bools in `bools`,
  // all keyed by field.key.
  const [numbers, setNumbers] = useState<Record<string, number | null>>({});
  const [categories, setCategories] = useState<Record<string, string | undefined>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [bools, setBools] = useState<Record<string, boolean>>({});

  // Initialize form state from field defaults whenever the form opens.
  const resetForm = useCallback(() => {
    const n: Record<string, number | null> = {};
    const c: Record<string, string | undefined> = {};
    const tx: Record<string, string> = {};
    const b: Record<string, boolean> = {};
    for (const f of trackable.fields) {
      if (f.type === "number") n[f.key] = typeof f.defaultValue === "number" ? f.defaultValue : null;
      else if (f.type === "rating") n[f.key] = null;
      else if (f.type === "category") c[f.key] = f.options?.[0];
      else if (f.type === "text") tx[f.key] = "";
      else if (f.type === "bool") b[f.key] = f.defaultValue ? true : false;
    }
    setNumbers(n);
    setCategories(c);
    setTexts(tx);
    setBools(b);
  }, [trackable]);

  useEffect(() => {
    if (open) resetForm();
  }, [open, resetForm]);

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

  // One-tap mode: clicking the card logs the single field's fixed value.
  const handleOneTap = useCallback(() => {
    if (!oneTap || !primary) return;
    if (oneTap === "bool") {
      writeEvent([{ name: primary.key, type: "bool", value: true }]);
    } else {
      writeEvent([{ name: primary.key, type: "number", value: 1, unit: primary.unit ?? "ct" }]);
    }
  }, [oneTap, primary, writeEvent]);

  // Rating-shaped: clicking a number logs immediately as one rating entry.
  const handleRatingClick = useCallback((n: number) => {
    if (!primary) return;
    writeEvent([
      { name: primary.key, type: "number", value: n, unit: "rating", scale: primary.scale ?? 5 },
    ]);
  }, [writeEvent, primary]);

  // Build the event from per-field form state.
  const handleSubmit = useCallback(() => {
    const eventEntries: LifeEntry[] = [];
    const labels: Record<string, string> = {};

    for (const f of trackable.fields) {
      if (f.type === "number") {
        const v = numbers[f.key];
        if (v === null || v === undefined) {
          if (f.optional) continue;
          message.warning(`Enter ${f.label ?? f.key}`);
          return;
        }
        eventEntries.push({ name: f.key, type: "number", value: v, unit: f.unit ?? "ct" });
      } else if (f.type === "rating") {
        const v = numbers[f.key];
        if (v === null || v === undefined) {
          if (f.optional !== false) continue; // ratings default to optional in forms
          message.warning(`Rate ${f.label ?? f.key}`);
          return;
        }
        eventEntries.push({ name: f.key, type: "number", value: v, unit: "rating", scale: f.scale ?? 5 });
      } else if (f.type === "text") {
        const v = (texts[f.key] ?? "").trim();
        if (!v) {
          if (f.optional !== false) continue;
          message.warning(`Enter ${f.label ?? f.key}`);
          return;
        }
        eventEntries.push({ name: f.key, type: "text", value: v });
      } else if (f.type === "bool") {
        eventEntries.push({ name: f.key, type: "bool", value: !!bools[f.key] });
      } else if (f.type === "category") {
        const v = categories[f.key];
        if (v) labels[f.key] = v;
      }
    }

    if (eventEntries.length === 0 && Object.keys(labels).length === 0) {
      message.warning("Nothing to log");
      return;
    }
    writeEvent(eventEntries, Object.keys(labels).length > 0 ? labels : undefined);
  }, [trackable, numbers, texts, bools, categories, writeEvent, message]);

  // ---- Quick-action chips: pins first, frecency fills the rest ----
  const pins = useMemo(() => trackable.pinned ?? [], [trackable.pinned]);
  const chips = useMemo<Array<{ payload: QuickPayload; pinned: boolean }>>(() => {
    const out: Array<{ payload: QuickPayload; pinned: boolean }> = pins.map((p) => ({
      payload: p,
      pinned: true,
    }));
    const remaining = MAX_CHIPS - out.length;
    if (remaining > 0) {
      const frecent = frecentPayloads(entries, trackable, { limit: remaining, exclude: pins });
      for (const p of frecent) out.push({ payload: p, pinned: false });
    }
    return out;
  }, [pins, entries, trackable]);

  // Tap a chip → log its exact payload (entries + category labels).
  const logPayload = useCallback((payload: QuickPayload) => {
    writeEvent(payload.entries, payload.labels);
  }, [writeEvent]);

  // Pin/unpin a chip's payload. Pins are presentation state on the manifest;
  // we compute the new list and hand the whole array to the backend, which
  // read-modify-writes just this trackable's `pinned[]` (atomic per the JSON
  // column). Frecency payloads are stored WITHOUT a label so the chip keeps
  // rendering its derived value label.
  const togglePin = useCallback(async (payload: QuickPayload, currentlyPinned: boolean) => {
    if (!logId) return;
    const key = payloadKey(payload);
    const next = currentlyPinned
      ? pins.filter((p) => payloadKey(p) !== key)
      : [...pins, payload];
    try {
      await life.setTrackablePins(logId, trackable.id, next);
    } catch (err) {
      console.error("Failed to update pins:", err);
      message.error("Failed to update pins");
    }
  }, [logId, pins, trackable.id, life, message]);

  const chipRow = chips.length > 0 ? (
    <ChipRow onClick={(e) => e.stopPropagation()}>
      {chips.map(({ payload, pinned }) => {
        const label = chipLabel(payload);
        return (
          <QuickChip key={`${pinned ? "p" : "f"}:${payloadKey(payload)}`} $pinned={pinned} data-testid="quick-chip">
            <ChipLog
              $pinned={pinned}
              disabled={saving || !logId}
              aria-label={`Log ${label}`}
              onClick={() => logPayload(payload)}
            >
              {label}
            </ChipLog>
            <ChipStar
              $pinned={pinned}
              aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
              onClick={() => togglePin(payload, pinned)}
            >
              {pinned ? <StarFilled /> : <StarOutlined />}
            </ChipStar>
          </QuickChip>
        );
      })}
    </ChipRow>
  ) : null;

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

  const headerLabel = <Label $size={size}>{trackable.label}</Label>;

  // Value badge — clickable for entries popover when there's logged data.
  const valueDisplay = (
    <>
      {dayEvents.length > 0 ? (
        <span onClick={(e) => e.stopPropagation()}>
          <EntriesPopover events={dayEvents} logId={logId}>
            <ValueBadge $logged={true} $size={size} title={`${dayEvents.length} ${dayEvents.length === 1 ? "entry" : "entries"}`}>
              {formatValueDisplay(agg, primaryUnit)}
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
        {chipRow}
      </Card>
    );
  }

  // Rating mode: picker is inline while no value is logged.
  if (rating && primary) {
    const scale = primary.scale ?? 5;
    const nums = Array.from({ length: scale }, (_, i) => i + 1);
    const logged = dayEvents.length > 0;
    return (
      <Card $size={size} $highlighted={logged}>
        <HeaderRow>
          {headerLabel}
          {valueDisplay}
        </HeaderRow>
        {!logged && (
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
        )}
        {chipRow}
      </Card>
    );
  }

  // Default mode: collapsed → tap "+" to open an inline form rendering one
  // editor per field.
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
          {trackable.fields.map((f) => (
            <FieldEditor
              key={f.key}
              field={f}
              size={size}
              numberValue={numbers[f.key] ?? null}
              onNumber={(v) => setNumbers((s) => ({ ...s, [f.key]: v }))}
              categoryValue={categories[f.key]}
              onCategory={(v) => setCategories((s) => ({ ...s, [f.key]: v }))}
              textValue={texts[f.key] ?? ""}
              onText={(v) => setTexts((s) => ({ ...s, [f.key]: v }))}
              boolValue={!!bools[f.key]}
              onBool={(v) => setBools((s) => ({ ...s, [f.key]: v }))}
            />
          ))}

          <Actions>
            <Button size="small" icon={<CloseOutlined />} onClick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={saving} onClick={handleSubmit}>
              Log
            </Button>
          </Actions>
          {dayEvents.length > 0 && (
            <Hint $muted>{dayEvents.length} logged today{breakdown ? ` · ${breakdown}` : ""}</Hint>
          )}
        </FormRow>
      )}

      {!open && chipRow}
      {!open && breakdown && <Hint $muted style={{ marginTop: 4 }}>{breakdown}</Hint>}
    </Card>
  );
}

// ---------- One field's editor ----------

interface FieldEditorProps {
  field: TypedField;
  size: WidgetSize;
  numberValue: number | null;
  onNumber: (v: number | null) => void;
  categoryValue: string | undefined;
  onCategory: (v: string) => void;
  textValue: string;
  onText: (v: string) => void;
  boolValue: boolean;
  onBool: (v: boolean) => void;
}

function FieldEditor({
  field,
  size,
  numberValue,
  onNumber,
  categoryValue,
  onCategory,
  textValue,
  onText,
  boolValue,
  onBool,
}: FieldEditorProps) {
  const label = field.label ?? field.key;
  switch (field.type) {
    case "number": {
      if (field.unit === "min") {
        return (
          <DurationFieldEditor
            label={label === field.key ? "Duration" : label}
            minutes={numberValue}
            initialUnit={defaultDurationInputUnit(field)}
            onChange={onNumber}
            size={size === "compact" ? "small" : "middle"}
            autoFocus
          />
        );
      }
      return (
        <NumberFieldEditor
          label={label}
          value={numberValue}
          onChange={onNumber}
          min={0}
          step={1}
          unit={field.unit === "ct" || field.unit === undefined ? undefined : field.unit}
          inputMode={inputModeFor(field)}
          size={size === "compact" ? "small" : "middle"}
          autoFocus
        />
      );
    }
    case "rating": {
      const scale = field.scale ?? 5;
      const nums = Array.from({ length: scale }, (_, i) => i + 1);
      return (
        <div>
          <FieldLabel>{label}</FieldLabel>
          <RatingRow>
            {nums.map((n) => (
              <RatingNum
                key={n}
                $selected={numberValue === n}
                onClick={() => onNumber(numberValue === n ? null : n)}
                aria-label={`${field.key} ${n}`}
              >
                {n}
              </RatingNum>
            ))}
          </RatingRow>
        </div>
      );
    }
    case "category": {
      return (
        <div>
          <FieldLabel>{label}</FieldLabel>
          <CategoryGroup>
            {(field.options ?? []).map((c) => (
              <CategoryChip key={c} $selected={categoryValue === c} onClick={() => onCategory(c)}>
                {c}
              </CategoryChip>
            ))}
          </CategoryGroup>
        </div>
      );
    }
    case "text": {
      return (
        <TextFieldEditor
          label={label}
          value={textValue}
          onChange={onText}
          placeholder="Optional"
          rows={2}
        />
      );
    }
    case "bool": {
      return (
        <Checkbox checked={boolValue} onChange={(e) => onBool(e.target.checked)}>
          {label}
        </Checkbox>
      );
    }
    default:
      // Unknown field type — skip rather than crash.
      return null;
  }
}
