/**
 * Bottom sheet for ONE shape (took / did / happened / rated) — the logging
 * surface behind each shape card.
 *
 * Flow (mobile-first):
 *   1. Typeahead over the vocab rows of this shape (case-insensitive label
 *      match). Typing a name with no exact match offers "Create" — slugifies
 *      the label and auto-registers a vocab row of this shape.
 *   2. Picking a thing prefills last-used values (most recent event for that
 *      subject, read name-agnostically) falling back to the vocab row's
 *      defaults, and shows:
 *        - per-thing quick chips (pins first, then frecency; star-to-pin)
 *        - the shape's input fields
 *        - a timestamp control defaulting to now (noon on past days)
 *        - Log — ALWAYS appends; the affordance never disappears
 *        - today's entries for the thing, inline-editable (EntriesList)
 *
 * Manifest mutations (create thing, pin/unpin) round-trip through the backend
 * and re-dispatch SET_LOG so `useTrackables()` consumers re-render with the
 * fresh vocabulary.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { Button, Drawer, Input, TimePicker } from "antd";
import { PlusOutlined, StarFilled, StarOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import {
  ManifestError,
  slugifyTrackableId,
  zonedDateTime,
  type LifeEvent,
  type LifeManifestTrackable,
  type QuickPayload,
  type TrackableShape,
} from "@homelab/backend";
import { useLifeContext } from "../life-context";
import {
  SHAPE_META,
  buildEntries,
  eventsForThing,
  formatAggregate,
  aggregateEvents,
  thingsOfShape,
  type ShapeFormValues,
} from "../lib/shapes";
import { frecentPayloads, payloadKey } from "../lib/frecency";
import { userTz } from "../lib/useUserTz";
import { useLogEvent } from "../lib/useLogEvent";
import { formatEntry } from "../lib/format";
import { EntriesList } from "./EntriesList";
import { NumberFieldEditor, DurationFieldEditor, TextFieldEditor } from "./EntryFields";

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
`;

const ThingList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const ThingRow = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-sm);
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-base);
  color: var(--color-text);
  cursor: pointer;
  text-align: left;

  &:hover { background: var(--color-bg-muted); }
`;

const ThingToday = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const SelectedHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-sm);
`;

const SelectedName = styled.span`
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
`;

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

const QuickChip = styled.div<{ $pinned: boolean }>`
  display: inline-flex;
  align-items: center;
  border: 1px solid ${(p) => (p.$pinned ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$pinned ? "var(--color-primary-light)" : "var(--color-bg)")};
  border-radius: 999px;
  overflow: hidden;
`;

const ChipLog = styled.button<{ $pinned: boolean }>`
  border: none;
  background: transparent;
  color: ${(p) => (p.$pinned ? "var(--color-primary)" : "var(--color-text)")};
  padding: 4px 6px 4px 12px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  cursor: pointer;

  &:hover { color: var(--color-primary); }
`;

const ChipStar = styled.button<{ $pinned: boolean }>`
  border: none;
  background: transparent;
  color: ${(p) => (p.$pinned ? "var(--color-primary)" : "var(--color-text-secondary)")};
  padding: 4px 10px 4px 2px;
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;

  &:hover { color: var(--color-primary); }
`;

const FormArea = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
`;

const FieldLabel = styled.div`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const RatingRow = styled.div`
  display: flex;
  gap: 6px;
`;

const RatingNum = styled.button<{ $selected: boolean }>`
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-border)")};
  background: ${(p) => (p.$selected ? "var(--color-primary)" : "var(--color-bg)")};
  color: ${(p) => (p.$selected ? "white" : "var(--color-text)")};
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
`;

const LogRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
`;

const SectionLabel = styled.div`
  font-size: var(--font-size-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
  margin-top: var(--space-xs);
`;

/** How many quick-action chips to show for a thing (pins + frecency). */
const MAX_THING_CHIPS = 4;

/** "How many minutes/oz did the last event carry?" — name-agnostic prefill. */
function lastUsedValues(events: LifeEvent[], subjectId: string, shape: TrackableShape): ShapeFormValues {
  const mine = events
    .filter((e) => e.subjectId === subjectId)
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  for (const ev of mine) {
    for (const e of ev.entries) {
      if (e.type !== "number") continue;
      if (shape === "took" && e.unit !== "rating") return { amount: e.value, unit: e.unit };
      if (shape === "did" && e.unit === "min") return { duration: e.value };
      if (shape === "rated" && e.unit === "rating") return { scale: e.scale ?? 5 };
    }
  }
  return {};
}

/** Prefill: last-used values, falling back to the vocab row's defaults. */
function prefillFor(
  thing: LifeManifestTrackable,
  events: LifeEvent[],
): ShapeFormValues {
  const last = lastUsedValues(events, thing.id, thing.shape);
  switch (thing.shape) {
    case "took":
      return {
        amount: last.amount ?? thing.defaultAmount ?? null,
        unit: last.unit ?? thing.defaultUnit,
      };
    case "did":
      return { duration: last.duration ?? thing.defaultDuration ?? null };
    case "rated":
      return { scale: last.scale ?? 5 };
    case "happened":
      return {};
    case "noted":
      // Reflective text is never prefilled (each note is fresh).
      return {};
  }
}

/** Human label for a quick chip ("5 mg", "30m · run"). */
function chipLabel(payload: QuickPayload): string {
  if (payload.label) return payload.label;
  const measured = payload.entries.filter((e) => e.type !== "text");
  const valuePart = measured.map(formatEntry).join(" ");
  const cat = payload.labels ? Object.values(payload.labels)[0] : undefined;
  return cat ? `${valuePart} · ${cat}` : valuePart;
}

function isToday(day: Date): boolean {
  return day.toDateString() === new Date().toDateString();
}

/** Default time-of-day for the timestamp control: now on today, noon otherwise. */
function defaultTime(day: Date): Dayjs {
  return isToday(day) ? dayjs() : dayjs(day).hour(12).minute(0).second(0).millisecond(0);
}

/**
 * Combine the viewed day with the picked time-of-day, in the USER's tz — so a
 * backfilled event lands in the tapped day's bucket even when the browser tz
 * differs from the user's tz. The picker's hour/minute are the wall-clock the
 * user sees; `zonedDateTime` maps that wall-clock on `day`'s local date to a
 * true UTC instant.
 */
function combine(day: Date, time: Dayjs, tz: string): Date {
  return zonedDateTime(day, time.hour(), time.minute(), tz);
}

export interface ShapeSheetProps {
  /** Which shape the sheet logs; null renders the sheet closed. */
  shape: TrackableShape | null;
  onClose: () => void;
  trackables: LifeManifestTrackable[];
  events: LifeEvent[];
  userId: string;
  logId: string | undefined;
  /** The day being viewed on the dashboard (start of day). */
  day: Date;
}

export function ShapeSheet({ shape, onClose, trackables, events, userId, logId, day }: ShapeSheetProps) {
  const { message } = useFeedback();
  const life = useLifeBackend();
  const { state, dispatch } = useLifeContext();
  const logEvent = useLogEvent();
  const tz = userTz();

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<ShapeFormValues>({});
  const [time, setTime] = useState<Dayjs>(() => defaultTime(day));
  const [busy, setBusy] = useState(false);

  // Reset the sheet whenever it (re)opens or the viewed day changes.
  useEffect(() => {
    if (!shape) return;
    setQuery("");
    setSelectedId(null);
    setValues({});
    setTime(defaultTime(day));
  }, [shape, day]);

  const things = useMemo(
    () => (shape ? thingsOfShape(trackables, shape) : []),
    [trackables, shape],
  );

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? things.filter((t) => t.label.toLowerCase().includes(q) || t.id.includes(q)) : things),
    [things, q],
  );
  const exactMatch = q !== "" && things.some((t) => t.label.toLowerCase() === q);

  const selected = useMemo(
    () => trackables.find((t) => t.id === selectedId) ?? null,
    [trackables, selectedId],
  );

  const pickThing = useCallback((thing: LifeManifestTrackable) => {
    setSelectedId(thing.id);
    setQuery("");
    setValues(prefillFor(thing, events));
  }, [events]);

  /** Persist a manifest mutation and refresh the in-memory log. */
  const applyManifest = useCallback(
    async (work: () => Promise<import("@homelab/backend").LifeManifest>) => {
      const manifest = await work();
      if (state.log) dispatch({ type: "SET_LOG", log: { ...state.log, manifest } });
      return manifest;
    },
    [state.log, dispatch],
  );

  // "Create <query>" — slugify and auto-register a vocab row of this shape.
  const handleCreate = useCallback(async () => {
    if (!shape || !logId) return;
    const label = query.trim();
    const id = slugifyTrackableId(label);
    if (!id) {
      message.warning("Give it a name with at least one letter or number");
      return;
    }
    const existing = trackables.find((t) => t.id === id);
    if (existing) {
      if (existing.shape !== shape) {
        message.error(`"${id}" already exists as a ${existing.shape} thing`);
        return;
      }
      // Same thing, possibly hidden — re-surface and select it.
      setBusy(true);
      try {
        if (existing.hidden) {
          await applyManifest(() => life.updateTrackable(logId, id, { hidden: false }));
        }
        pickThing(existing);
      } catch (err) {
        console.error("Failed to restore trackable:", err);
        message.error("Failed to restore");
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      const manifest = await applyManifest(() => life.addTrackable(logId, { id, label, shape }));
      const created = manifest.trackables.find((t) => t.id === id);
      if (created) pickThing(created);
    } catch (err) {
      console.error("Failed to create trackable:", err);
      message.error(err instanceof ManifestError ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }, [shape, logId, query, trackables, life, applyManifest, pickThing, message]);

  // ---- Logging --------------------------------------------------------

  const doLog = useCallback(
    async (entries: import("@homelab/backend").LifeEntry[], labels?: Record<string, string>) => {
      if (!selected || !logId || !userId) return;
      const valuePart = entries.filter((e) => e.type !== "text").map(formatEntry).join(" ");
      await logEvent({
        logId,
        userId,
        subjectId: selected.id,
        entries,
        labels,
        timestamp: combine(day, time, tz),
        label: `${selected.label} ${valuePart}`.trim(),
      });
    },
    [selected, logId, userId, logEvent, day, time, tz],
  );

  const handleLog = useCallback(async () => {
    if (!selected) return;
    const entries = buildEntries(selected.shape, values);
    if (!entries) {
      message.warning(
        selected.shape === "took" ? "Enter an amount"
          : selected.shape === "did" ? "Enter a duration"
            : selected.shape === "noted" ? "Write something first"
              : "Pick a rating",
      );
      return;
    }
    await doLog(entries);
    // Rated: clear the picked rating so the next log is a fresh choice (the
    // shape's other prefills are replay-friendly and persist).
    if (selected.shape === "rated") setValues((v) => ({ ...v, rating: null }));
    if (selected.shape === "did") setValues((v) => ({ ...v, rating: null, notes: "" }));
    // Noted: clear the text so a follow-up note starts blank.
    if (selected.shape === "noted") setValues((v) => ({ ...v, text: "" }));
  }, [selected, values, doLog, message]);

  // ---- Per-thing chips: pins first, frecency fills ---------------------

  const pins = useMemo(() => selected?.pinned ?? [], [selected]);
  const chips = useMemo(() => {
    if (!selected) return [];
    const out: Array<{ payload: QuickPayload; pinned: boolean }> = pins.map((p) => ({ payload: p, pinned: true }));
    const remaining = MAX_THING_CHIPS - out.length;
    if (remaining > 0) {
      for (const p of frecentPayloads(events, selected.id, { limit: remaining, exclude: pins })) {
        out.push({ payload: p, pinned: false });
      }
    }
    return out;
  }, [selected, pins, events]);

  const togglePin = useCallback(async (payload: QuickPayload, currentlyPinned: boolean) => {
    if (!selected || !logId) return;
    const key = payloadKey(selected.id, payload);
    const next = currentlyPinned
      ? pins.filter((p) => payloadKey(selected.id, p) !== key)
      : [...pins, payload];
    try {
      await applyManifest(() => life.updateTrackable(logId, selected.id, { pinned: next }));
    } catch (err) {
      console.error("Failed to update pins:", err);
      message.error("Failed to update pins");
    }
  }, [selected, logId, pins, life, applyManifest, message]);

  // ---- Today's entries for the selected thing ---------------------------

  const todaysEvents = useMemo(
    () => (selected ? eventsForThing(events, selected.id, day, tz) : []),
    [selected, events, day, tz],
  );

  const todaySummaryFor = useCallback((thingId: string) => {
    const todays = eventsForThing(events, thingId, day, tz);
    if (todays.length === 0) return null;
    return formatAggregate(aggregateEvents(todays));
  }, [events, day, tz]);

  const meta = shape ? SHAPE_META[shape] : null;

  return (
    <Drawer
      open={shape !== null}
      onClose={onClose}
      placement="bottom"
      height="82%"
      title={meta ? meta.title : ""}
      destroyOnClose
      styles={{ body: { padding: "var(--space-sm) var(--space-md)" } }}
    >
      {shape && (
        <Body>
          <Input
            placeholder={`Search or add — ${meta?.hint ?? ""}`}
            value={query}
            allowClear
            autoFocus={false}
            onChange={(e) => {
              setQuery(e.target.value);
              if (selectedId) setSelectedId(null);
            }}
            data-testid="shape-sheet-search"
          />

          {!selected && (
            <ThingList>
              {matches.map((t) => {
                const summary = todaySummaryFor(t.id);
                return (
                  <ThingRow key={t.id} onClick={() => pickThing(t)} data-testid="shape-sheet-thing">
                    <span>{t.label}</span>
                    {summary && <ThingToday>{summary} today</ThingToday>}
                  </ThingRow>
                );
              })}
              {q !== "" && !exactMatch && (
                <Button
                  type="dashed"
                  icon={<PlusOutlined />}
                  onClick={handleCreate}
                  loading={busy}
                  disabled={!logId}
                  data-testid="shape-sheet-create"
                >
                  Create “{query.trim()}”
                </Button>
              )}
              {matches.length === 0 && q === "" && (
                <ThingToday>Nothing here yet — type a name to add one.</ThingToday>
              )}
            </ThingList>
          )}

          {selected && (
            <>
              <SelectedHeader>
                <SelectedName>{selected.label}</SelectedName>
                <Button type="link" size="small" onClick={() => setSelectedId(null)}>
                  change
                </Button>
              </SelectedHeader>

              {chips.length > 0 && (
                <ChipRow>
                  {chips.map(({ payload, pinned }) => {
                    const label = chipLabel(payload);
                    return (
                      <QuickChip key={`${pinned ? "p" : "f"}:${payloadKey(selected.id, payload)}`} $pinned={pinned} data-testid="thing-chip">
                        <ChipLog
                          $pinned={pinned}
                          aria-label={`Log ${label}`}
                          onClick={() => doLog(payload.entries, payload.labels)}
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
              )}

              <FormArea>
                {selected.shape === "took" && (
                  <>
                    <NumberFieldEditor
                      label="Amount"
                      value={values.amount ?? null}
                      onChange={(v) => setValues((s) => ({ ...s, amount: v }))}
                      min={0}
                      inputMode="decimal"
                      size="middle"
                    />
                    <TextFieldEditor
                      label="Unit"
                      value={values.unit ?? ""}
                      onChange={(v) => setValues((s) => ({ ...s, unit: v }))}
                      placeholder="mg, oz, drinks… (blank = count)"
                      size="middle"
                    />
                  </>
                )}

                {selected.shape === "did" && (
                  <>
                    <DurationFieldEditor
                      label="Duration"
                      minutes={values.duration ?? null}
                      onChange={(v) => setValues((s) => ({ ...s, duration: v }))}
                      size="middle"
                    />
                    {selected.ratingLabel && (
                      <div>
                        <FieldLabel>{selected.ratingLabel} (optional)</FieldLabel>
                        <RatingRow>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <RatingNum
                              key={n}
                              $selected={values.rating === n}
                              onClick={() => setValues((s) => ({ ...s, rating: s.rating === n ? null : n }))}
                              aria-label={`${selected.ratingLabel} ${n}`}
                            >
                              {n}
                            </RatingNum>
                          ))}
                        </RatingRow>
                      </div>
                    )}
                    <TextFieldEditor
                      label="Notes"
                      value={values.notes ?? ""}
                      onChange={(v) => setValues((s) => ({ ...s, notes: v }))}
                      placeholder="Optional"
                      rows={2}
                    />
                  </>
                )}

                {selected.shape === "happened" && (
                  <FieldLabel>One tap, one count — hit Log.</FieldLabel>
                )}

                {selected.shape === "rated" && (
                  <RatingRow>
                    {Array.from({ length: values.scale ?? 5 }, (_, i) => i + 1).map((n) => (
                      <RatingNum
                        key={n}
                        $selected={values.rating === n}
                        onClick={() => setValues((s) => ({ ...s, rating: s.rating === n ? null : n }))}
                        aria-label={`Rate ${n}`}
                      >
                        {n}
                      </RatingNum>
                    ))}
                  </RatingRow>
                )}

                {/* Reflective free-text capture. `noted` vocab is View-only, so
                    this branch isn't reachable from the dashboard shape pickers.
                    Views don't reuse this widget — the ViewRunner renders its own
                    antd Input.TextArea + buildEntries — so this branch only keeps
                    ShapeSheet total over every shape (no unhandled `noted` case). */}
                {selected.shape === "noted" && (
                  <TextFieldEditor
                    label={selected.prompt ?? "Note"}
                    value={values.text ?? ""}
                    onChange={(v) => setValues((s) => ({ ...s, text: v }))}
                    placeholder="A few words…"
                    rows={4}
                  />
                )}

                <LogRow>
                  <TimePicker
                    value={time}
                    onChange={(t) => t && setTime(t)}
                    format="h:mm A"
                    use12Hours
                    allowClear={false}
                    size="middle"
                    style={{ width: 120 }}
                  />
                  <Button type="primary" onClick={handleLog} disabled={!logId} data-testid="shape-sheet-log">
                    Log
                  </Button>
                </LogRow>
              </FormArea>

              <SectionLabel>
                {isToday(day) ? "Today" : day.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </SectionLabel>
              <EntriesList events={todaysEvents} emptyText="Nothing logged yet" />
            </>
          )}
        </Body>
      )}
    </Drawer>
  );
}
