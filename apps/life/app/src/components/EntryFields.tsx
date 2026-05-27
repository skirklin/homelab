/**
 * Controlled value-field primitives shared by the add (EventLogger) and edit
 * (EntriesPopover) surfaces, so a sleep duration entered in either place looks
 * and behaves the same.
 *
 * Each primitive is purely controlled — it owns no commit policy. The caller
 * decides whether to debounce, accumulate in local state, or fire immediately:
 *
 *   - EntriesPopover wraps these with debounce + commit-to-backend on change.
 *   - EventLogger wraps them with local React state and only writes on Submit.
 *
 * Design intent (the previous cramped add form was the symptom this fixes):
 *   - Stack label / input / unit toggle vertically so the InputNumber claims
 *     the full card width on a phone. The horizontal one-row layout squeezed
 *     the InputNumber to ~40px and made the digits illegible.
 *   - `controls={false}` on every InputNumber — the up/down arrows eat ~28px
 *     of the field on mobile, leaving no room to render digits. Mobile users
 *     tap and type.
 *   - `inputMode="decimal"` for durations, `"numeric"` for counts, so the
 *     phone keyboard surfaces the right glyph set.
 */
import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { InputNumber, Segmented, Input } from "antd";

const FieldStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
`;

const FieldLabel = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const InputRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
`;

// Minimum width that comfortably renders 4 digits (e.g. "1440") in antd
// InputNumber's small size on iOS Safari. Below this the digits start to clip.
const NUMBER_INPUT_MIN_WIDTH = 88;

// ---------- NumberFieldEditor ----------

export interface NumberFieldEditorProps {
  value: number | null;
  onChange: (next: number | null) => void;
  /** Label rendered above the field. Pass empty string to suppress. */
  label?: string;
  /** Small unit hint rendered to the right of the input (e.g. "mg", "oz"). */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  size?: "small" | "middle" | "large";
  autoFocus?: boolean;
  onBlur?: () => void;
  /** "decimal" for floats, "numeric" for ints. Default: "numeric". */
  inputMode?: "decimal" | "numeric";
  /** Compactly rendered "…" while a parent commit is in flight. */
  saving?: boolean;
  /** Extra width override for the InputNumber, overrides the default min. */
  width?: number;
}

export function NumberFieldEditor({
  value,
  onChange,
  label,
  unit,
  min,
  max,
  step,
  size = "small",
  autoFocus,
  onBlur,
  inputMode = "numeric",
  saving,
  width,
}: NumberFieldEditorProps) {
  return (
    <FieldStack>
      {label !== undefined && label !== "" && <FieldLabel>{label}</FieldLabel>}
      <InputRow>
        <InputNumber
          size={size}
          value={value}
          min={min}
          max={max}
          step={step}
          controls={false}
          inputMode={inputMode}
          autoFocus={autoFocus}
          onChange={(v) => onChange(typeof v === "number" ? v : null)}
          onBlur={onBlur}
          style={{ minWidth: width ?? NUMBER_INPUT_MIN_WIDTH, flex: width ? "0 0 auto" : "1" }}
        />
        {unit && <FieldLabel style={{ minWidth: 0 }}>{unit}</FieldLabel>}
        {saving && <SavingDot />}
      </InputRow>
    </FieldStack>
  );
}

// ---------- DurationFieldEditor ----------

/**
 * Duration editor — owns the hours-vs-minutes display toggle internally so a
 * caller only deals with canonical minutes. Edits convert back to minutes
 * before being surfaced via `onChange`. Hours mode uses a 0.5 step so half-hour
 * naps slide on the spinner; minutes mode uses 1.
 */
export interface DurationFieldEditorProps {
  /** Canonical minutes. */
  minutes: number | null;
  onChange: (nextMinutes: number | null) => void;
  /** Initial display unit. Defaults: hours when >= 60, else minutes. */
  initialUnit?: "hours" | "minutes";
  label?: string;
  size?: "small" | "middle" | "large";
  autoFocus?: boolean;
  onBlur?: () => void;
  saving?: boolean;
}

/** Mirrors EntriesPopover's old heuristic — historical events stored "in hours"
 *  show as a tidy 5-minute multiple (8h, 8h 30m); ad-hoc minute logs (47, 13)
 *  don't. */
export function pickDurationDisplayUnit(minutes: number): "hours" | "minutes" {
  return minutes >= 60 && minutes % 5 === 0 ? "hours" : "minutes";
}

export function DurationFieldEditor({
  minutes,
  onChange,
  initialUnit,
  label = "Duration",
  size = "small",
  autoFocus,
  onBlur,
  saving,
}: DurationFieldEditorProps) {
  const [displayUnit, setDisplayUnit] = useState<"hours" | "minutes">(() => {
    if (initialUnit) return initialUnit;
    if (minutes == null) return "minutes";
    return pickDurationDisplayUnit(minutes);
  });

  // If the upstream minutes value swaps to a value that's clearly a different
  // shape (e.g. parent reset the form), re-pick the display unit. Skip when
  // the user has explicitly chosen a unit by interacting with the segmented
  // (we can't easily disambiguate, so only re-pick on null→value transitions).
  const lastSeenRef = useRef<number | null>(minutes);
  useEffect(() => {
    if (lastSeenRef.current === null && minutes !== null && !initialUnit) {
      setDisplayUnit(pickDurationDisplayUnit(minutes));
    }
    lastSeenRef.current = minutes;
  }, [minutes, initialUnit]);

  const displayed =
    minutes === null
      ? null
      : displayUnit === "hours"
        ? Math.round((minutes / 60) * 100) / 100
        : minutes;

  return (
    <FieldStack>
      {label !== "" && <FieldLabel>{label}</FieldLabel>}
      <InputRow>
        <InputNumber
          size={size}
          value={displayed}
          min={0}
          step={displayUnit === "hours" ? 0.5 : 1}
          controls={false}
          inputMode="decimal"
          autoFocus={autoFocus}
          onChange={(v) => {
            if (typeof v !== "number") {
              onChange(null);
              return;
            }
            onChange(displayUnit === "hours" ? Math.round(v * 60) : v);
          }}
          onBlur={onBlur}
          style={{ minWidth: NUMBER_INPUT_MIN_WIDTH, flex: 1 }}
        />
        <Segmented
          size="small"
          options={[
            { label: "min", value: "minutes" },
            { label: "hr", value: "hours" },
          ]}
          value={displayUnit}
          onChange={(v) => setDisplayUnit(v as "hours" | "minutes")}
        />
        {saving && <SavingDot />}
      </InputRow>
    </FieldStack>
  );
}

// ---------- TextFieldEditor ----------

export interface TextFieldEditorProps {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  placeholder?: string;
  size?: "small" | "middle" | "large";
  onBlur?: () => void;
  saving?: boolean;
  rows?: number;
}

export function TextFieldEditor({
  value,
  onChange,
  label,
  placeholder,
  size = "small",
  onBlur,
  saving,
  rows,
}: TextFieldEditorProps) {
  return (
    <FieldStack>
      {label !== undefined && label !== "" && <FieldLabel>{label}</FieldLabel>}
      <InputRow style={{ width: "100%" }}>
        {rows && rows > 1 ? (
          <Input.TextArea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            rows={rows}
            placeholder={placeholder}
            style={{ flex: 1 }}
          />
        ) : (
          <Input
            size={size}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            placeholder={placeholder}
            style={{ flex: 1 }}
          />
        )}
        {saving && <SavingDot />}
      </InputRow>
    </FieldStack>
  );
}

// ---------- shared bits ----------

const SavingDot = styled.span.attrs({ children: "…" })`
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
`;
