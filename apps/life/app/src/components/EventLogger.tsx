/**
 * Generic event logger card. One component replaces all bespoke widget
 * renderers. Behaviour is driven by the Trackable manifest entry:
 *
 *  - "ct" trackables with defaultValue=1 and no categories/intensity/notes
 *    are "one-tap" — clicking the card logs `{value: 1}` instantly. This is
 *    the old counter ergonomics for floss / poop / etc.
 *  - rating-shaped (unit: "rating") trackables show a 1-5 picker inline.
 *  - everything else expands an inline form with value (pre-filled from
 *    defaultValue), an optional category picker, intensity buttons, and a
 *    notes field.
 *
 * The card always shows the day's aggregated value (sum/avg/last) so the
 * dashboard reads at a glance. Tap the value badge to open an entries
 * popover (delete individual entries).
 */
import { useState, useRef, useEffect, useCallback } from "react";
import styled, { css } from "styled-components";
import { Input, InputNumber, Button } from "antd";
import { PlusOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import type { Trackable } from "../manifest";
import type { LogEntry } from "../types";
import { type WidgetSize } from "../display-settings";
import { getEntriesForTrackable, type NormalizedEvent } from "../lib/legacy-adapter";
import { EntriesPopover } from "./EntriesPopover";

interface EventLoggerProps {
  trackable: Trackable;
  /** All entries for the log (raw — adapter is applied internally). */
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

// ---------- One-tap detection ----------

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

// ---------- Aggregation ----------

function aggregateValue(events: NormalizedEvent[], aggregation: Trackable["aggregation"]): number | null {
  if (events.length === 0) return null;
  const values = events
    .map((e) => e.data.value)
    .filter((v): v is number => typeof v === "number");
  if (values.length === 0) return null;
  switch (aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    case "last":
      return values[0]; // events arrive sorted most-recent-first
  }
}

function formatValue(value: number | null, trackable: Trackable): string {
  if (value === null) return "—";
  if (trackable.unit === "rating") return `${value}/5`;
  if (trackable.unit === "ct") return `${value}`;
  return `${value} ${trackable.unit}`;
}

function categoryBreakdown(events: NormalizedEvent[], unit: string): string | null {
  const byCat: Record<string, number> = {};
  for (const e of events) {
    const v = e.data.value;
    if (typeof v !== "number") continue;
    const cat = (e.data.category as string | undefined) ?? "—";
    byCat[cat] = (byCat[cat] ?? 0) + v;
  }
  const parts = Object.entries(byCat);
  if (parts.length <= 1) return null;
  return parts.map(([cat, v]) => `${cat} ${v}${unit === "min" ? "" : ""}`).join(" + ");
}

// ---------- Component ----------

export function EventLogger({ trackable, entries, userId, logId, timestamp, size = "normal" }: EventLoggerProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();

  const dayEntries = getEntriesForTrackable(entries, trackable.id, timestamp);
  const agg = aggregateValue(dayEntries, trackable.aggregation);
  const breakdown = trackable.categories ? categoryBreakdown(dayEntries, trackable.unit) : null;
  const oneTap = isOneTap(trackable);
  const rating = isRatingShaped(trackable);

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState<number | null>(trackable.defaultValue ?? null);
  const [category, setCategory] = useState<string | undefined>(trackable.categories?.[0]);
  const [intensity, setIntensity] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  // Reset form state on open so each log starts fresh.
  useEffect(() => {
    if (open) {
      setValue(trackable.defaultValue ?? null);
      setCategory(trackable.categories?.[0]);
      setIntensity(null);
      setNotes("");
    }
  }, [open, trackable]);

  const cancelEdit = useCallback(() => {
    setOpen(false);
  }, []);

  const log = useCallback(async (data: Record<string, unknown>) => {
    if (!logId || !userId) return;
    setSaving(true);
    try {
      await life.addEntry(logId, trackable.id, data, userId, { timestamp });
      setOpen(false);
    } catch (err) {
      console.error("Failed to log:", err);
      message.error("Failed to log");
    } finally {
      setSaving(false);
    }
  }, [logId, userId, trackable.id, timestamp, life, message]);

  // One-tap mode: clicking the card logs {value: 1} immediately.
  const handleOneTap = useCallback(() => {
    if (oneTap) log({ value: 1 });
  }, [oneTap, log]);

  // Rating-shaped: clicking a number logs immediately.
  const handleRatingClick = useCallback((n: number) => {
    log({ value: n });
  }, [log]);

  const handleSubmit = useCallback(() => {
    if (value === null) {
      message.warning("Enter a value");
      return;
    }
    const data: Record<string, unknown> = { value };
    if (category) data.category = category;
    if (intensity !== null) data.intensity = intensity;
    if (notes.trim()) data.notes = notes.trim();
    log(data);
  }, [value, category, intensity, notes, log, message]);

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
  const valueDisplay = (
    <>
      {dayEntries.length > 0 ? (
        <EntriesPopover entries={dayEntries} logId={logId}>
          <ValueBadge $logged={true} $size={size} title={`${dayEntries.length} ${dayEntries.length === 1 ? "entry" : "entries"}`}>
            {formatValue(agg, trackable)}
            {dayEntries.length > 1 && <span>· {dayEntries.length}</span>}
          </ValueBadge>
        </EntriesPopover>
      ) : (
        <ValueBadge $logged={false} $size={size} as="span">—</ValueBadge>
      )}
    </>
  );

  // --- Render ---

  // One-tap mode: the whole card is a button.
  if (oneTap) {
    return (
      <Card $size={size} $highlighted={dayEntries.length > 0} onClick={handleOneTap} style={{ cursor: "pointer" }}>
        <HeaderRow>
          {headerLabel}
          {dayEntries.length > 0 ? (
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
      <Card $size={size} $highlighted={dayEntries.length > 0}>
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
  return (
    <Card $size={size} $highlighted={dayEntries.length > 0}>
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
            <FieldLabel style={{ minWidth: 60 }}>{trackable.unit}</FieldLabel>
            <InputNumber
              value={value}
              onChange={(v) => setValue(typeof v === "number" ? v : null)}
              min={0}
              autoFocus
              style={{ flex: 1 }}
              size={size === "compact" ? "small" : "middle"}
            />
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
          {dayEntries.length > 0 && (
            <Hint>{dayEntries.length} logged today{breakdown ? ` · ${breakdown}` : ""}</Hint>
          )}
        </FormRow>
      )}

      {!open && breakdown && <Hint style={{ marginTop: 4 }}>{breakdown}</Hint>}
    </Card>
  );
}
