/**
 * View-layer bundle module for the AI observer.
 *
 * Assembles a cross-source narrative document from the user's data for a
 * given time window. Output is markdown prose intended as context for the
 * Anthropic API. See apps/life/OBSERVER_BUILD_PLAN.md (P0-2) and
 * apps/life/DATA_COLLECTION.md for design philosophy (V4 / V6).
 *
 * Design principles:
 * - Text fields are king. Journal entries carry almost all signal.
 * - Don't summarize — present. The LLM finds its own patterns.
 * - Cross-source joins are the bundle's job, structured per-day so the
 *   model can correlate "what was written" with "what was done" on the
 *   same date.
 * - Operational noise (recurring household tasks, raw count trackers)
 *   stays out of the per-day narrative and lives in a separate aggregate
 *   summary so it doesn't drown out the signal.
 * - Empty is fine. Say so briefly, don't pad.
 */
import type PocketBase from "pocketbase";
import { formatInTimeZone } from "date-fns-tz";
import { safeTz } from "../notifications/tz";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BundleOptions {
  /** PocketBase client (already authenticated as the user) */
  pb: PocketBase;
  /** Start of the data window */
  windowStart: Date;
  /** End of the data window */
  windowEnd: Date;
  /** User's timezone (IANA string like "America/Los_Angeles"), for formatting */
  timezone?: string;
}

export interface BundleResult {
  /** The assembled markdown document */
  markdown: string;
  /** IDs of life_events included (for linking observations back to source) */
  relatedEventIds: string[];
}

interface LifeEventRecord {
  id: string;
  subject_id: string;
  timestamp: string;
  entries: Array<{ name: string; type: string; value: unknown; unit?: string }>;
  labels?: Record<string, string> | null;
}

interface RecipeEventRecord {
  id: string;
  subject_id: string;
  timestamp: string;
  entries: Array<{ name: string; type: string; value: unknown }>;
  recipe_snapshot?: { name?: string } | null;
}

interface TaskRecord {
  id: string;
  name: string;
  completed: boolean;
  task_type: string;
  last_completed: string | null;
}

interface TaskEventRecord {
  id: string;
  subject_id: string;
  timestamp: string;
}

interface TripRecord {
  id: string;
  destination: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface ActivityRecord {
  id: string;
  trip_id: string;
  name: string;
  category: string;
  location: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSION_SUBJECTS = ["morning_session", "evening_session", "weekly_review_session"];

/**
 * Fallback timezone for bundle assembly. The observer is currently a
 * single-tenant tool (Scott) and the user explicitly prefers Pacific over
 * UTC when the browser-pushed tz is missing — see memory
 * `feedback_user_tz_from_browser`. Matches the convention used elsewhere
 * for human-facing renders.
 */
const FALLBACK_TZ = "America/Los_Angeles";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** ISO `yyyy-MM-dd` in the user's local tz — stable Map key. */
function localDayKey(isoStr: string, tz: string): string {
  return formatInTimeZone(new Date(isoStr), tz, "yyyy-MM-dd");
}

/** Human-friendly day label, e.g. "Wednesday, May 27". */
function formatDayHeading(dayKey: string, tz: string): string {
  // dayKey is `yyyy-MM-dd` in tz; reconstruct an instant inside that day
  // and render. Noon avoids any DST-edge ambiguity.
  return formatInTimeZone(new Date(`${dayKey}T12:00:00Z`), tz, "EEEE, MMMM d");
}

function formatDateRange(start: Date, end: Date, tz: string): string {
  return `${formatInTimeZone(start, tz, "MMM d")} – ${formatInTimeZone(end, tz, "MMM d, yyyy")}`;
}

function extractTextEntries(
  entries: Array<{ name: string; type: string; value: unknown }>,
): Array<{ name: string; value: string }> {
  return entries
    .filter((e) => e.type === "text" && typeof e.value === "string" && (e.value as string).trim())
    .map((e) => ({ name: e.name, value: (e.value as string).trim() }));
}

function extractNumericEntries(
  entries: Array<{ name: string; type: string; value: unknown; unit?: string }>,
): Array<{ name: string; value: number; unit: string }> {
  return entries
    .filter((e) => e.type === "number" && typeof e.value === "number")
    .map((e) => ({ name: e.name, value: e.value as number, unit: e.unit || "" }));
}

function extractCategoryEntries(
  entries: Array<{ name: string; type: string; value: unknown }>,
): Array<{ name: string; value: string }> {
  return entries
    .filter(
      (e) =>
        (e.type === "category" || e.type === "select") &&
        typeof e.value === "string" &&
        (e.value as string).trim(),
    )
    .map((e) => ({ name: e.name, value: (e.value as string).trim() }));
}

/** Title-case a snake_case identifier ("morning_session" -> "Morning session"). */
function humanize(snake: string): string {
  const words = snake.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

// ─── Data fetchers ───────────────────────────────────────────────────────────

async function fetchLifeEvents(
  pb: PocketBase,
  windowStart: Date,
  windowEnd: Date,
): Promise<LifeEventRecord[]> {
  try {
    return await pb.collection("life_events").getFullList<LifeEventRecord>({
      filter: pb.filter(
        "timestamp >= {:start} && timestamp <= {:end}",
        { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      ),
      sort: "timestamp",
    });
  } catch {
    return [];
  }
}

async function fetchCookingLog(
  pb: PocketBase,
  windowStart: Date,
  windowEnd: Date,
): Promise<RecipeEventRecord[]> {
  try {
    return await pb.collection("recipe_events").getFullList<RecipeEventRecord>({
      filter: pb.filter(
        "timestamp >= {:start} && timestamp <= {:end}",
        { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      ),
      sort: "timestamp",
    });
  } catch {
    return [];
  }
}

async function fetchCompletedTasks(
  pb: PocketBase,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ tasks: TaskRecord[]; events: TaskEventRecord[] }> {
  try {
    // Recurring completions are flagged as noise per the spec and not
    // rendered — but we still fetch them so future surfaces (e.g.
    // V5 derived "days since last X") can use them without another query.
    const events = await pb.collection("task_events").getFullList<TaskEventRecord>({
      filter: pb.filter(
        "timestamp >= {:start} && timestamp <= {:end}",
        { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      ),
      sort: "timestamp",
    });

    // One-shot tasks marked complete in the window — these are the
    // narrative-shaped completions (trip prep, projects).
    const tasks = await pb.collection("tasks").getFullList<TaskRecord>({
      filter: pb.filter(
        "task_type = 'one_shot' && completed = true && updated >= {:start} && updated <= {:end}",
        { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      ),
    });

    return { tasks, events };
  } catch {
    return { tasks: [], events: [] };
  }
}

async function fetchActiveTravel(
  pb: PocketBase,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ trips: TripRecord[]; activities: ActivityRecord[] }> {
  try {
    // Trips overlapping the window OR starting within 7 days of window end
    const lookahead = new Date(windowEnd.getTime() + 7 * 24 * 60 * 60 * 1000);
    const trips = await pb.collection("travel_trips").getFullList<TripRecord>({
      filter: pb.filter(
        "(start_date <= {:end} && end_date >= {:start}) || " +
        "(start_date >= {:start} && start_date <= {:lookahead})",
        {
          start: windowStart.toISOString().split("T")[0],
          end: windowEnd.toISOString().split("T")[0],
          lookahead: lookahead.toISOString().split("T")[0],
        },
      ),
    });

    if (trips.length === 0) return { trips: [], activities: [] };

    // Single batched query for activities across all relevant trips.
    const tripFilter = trips
      .map((t) => pb.filter("trip_id = {:tripId}", { tripId: t.id }))
      .join(" || ");
    let activities: ActivityRecord[] = [];
    try {
      activities = await pb.collection("travel_activities").getFullList<ActivityRecord>({
        filter: tripFilter,
      });
    } catch {
      activities = [];
    }

    return { trips, activities };
  } catch {
    return { trips: [], activities: [] };
  }
}

/**
 * Batch-resolve recipe names for cooking events that lack a snapshot.
 * Uses a single OR'd PB filter instead of one getOne per id (was N+1).
 */
async function resolveRecipeNames(
  pb: PocketBase,
  recipeIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (recipeIds.length === 0) return nameMap;
  const filter = recipeIds
    .map((id) => pb.filter("id = {:id}", { id }))
    .join(" || ");
  try {
    const recipes = await pb
      .collection("recipes")
      .getFullList<{ id: string; data: { name?: string } }>({ filter });
    for (const r of recipes) {
      if (r.data?.name) nameMap.set(r.id, r.data.name);
    }
  } catch {
    // Whole batch failed — render falls back to "Unknown recipe".
  }
  return nameMap;
}

// ─── Per-day narrative ───────────────────────────────────────────────────────

type DayEntry =
  | { kind: "morning"; event: LifeEventRecord }
  | { kind: "evening"; event: LifeEventRecord }
  | { kind: "weekly_review"; event: LifeEventRecord }
  | { kind: "cooking"; event: RecipeEventRecord; recipeName: string }
  | { kind: "tracker_text"; event: LifeEventRecord }
  | { kind: "exercise"; event: LifeEventRecord };

/**
 * Decide whether a non-session life event has narrative-shaped content
 * worth interleaving with journal text. Plain count/duration events
 * (poop=1, floss=1, coffee=8oz) are operational noise — they live in the
 * activity summary instead.
 */
function trackerNarrativeKind(event: LifeEventRecord): DayEntry["kind"] | null {
  if (SESSION_SUBJECTS.includes(event.subject_id)) return null;
  if (event.subject_id === "exercise") return "exercise";
  if (event.subject_id === "quick_capture") return "tracker_text";
  // Any other tracker with a non-empty text entry counts as narrative.
  if (extractTextEntries(event.entries).length > 0) return "tracker_text";
  return null;
}

function renderMorningSession(event: LifeEventRecord): string | null {
  const text = extractTextEntries(event.entries);
  if (text.length === 0) return null;
  const gratitude = text.find((t) => t.name === "gratitude")?.value;
  const intention = text.find((t) => t.name === "intention")?.value;
  const others = text.filter((t) => t.name !== "gratitude" && t.name !== "intention");

  const lines: string[] = ["*Morning session.*"];
  if (gratitude) lines.push(`Grateful for: ${gratitude}`);
  if (intention) lines.push(`Intention: ${intention}`);
  for (const o of others) lines.push(`${humanize(o.name)}: ${o.value}`);
  return lines.join(" ");
}

function renderEveningSession(event: LifeEventRecord): string | null {
  const text = extractTextEntries(event.entries);
  if (text.length === 0) return null;
  const win = text.find((t) => t.name === "win")?.value;
  const lesson = text.find((t) => t.name === "lesson")?.value;
  const followup = text.find((t) => t.name === "intention_followup")?.value;
  const others = text.filter(
    (t) => t.name !== "win" && t.name !== "lesson" && t.name !== "intention_followup",
  );

  const lines: string[] = ["*Evening session.*"];
  if (win) lines.push(`Win: ${win}`);
  if (lesson) lines.push(`Lesson: ${lesson}`);
  if (followup) lines.push(`On the morning intention: ${followup}`);
  for (const o of others) lines.push(`${humanize(o.name)}: ${o.value}`);
  return lines.join(" ");
}

function renderWeeklyReview(event: LifeEventRecord): string | null {
  const text = extractTextEntries(event.entries);
  if (text.length === 0) return null;
  const lines: string[] = ["*Weekly review.*"];
  for (const t of text) lines.push(`${humanize(t.name)}: ${t.value}`);
  return lines.join(" ");
}

function renderCooking(event: RecipeEventRecord, recipeName: string): string {
  const notes = extractTextEntries(event.entries);
  const noteStr = notes.length > 0 ? ` — ${notes.map((n) => n.value).join("; ")}` : "";
  return `Cooked **${recipeName}**${noteStr}.`;
}

function renderExercise(event: LifeEventRecord): string {
  const cats = extractCategoryEntries(event.entries);
  const nums = extractNumericEntries(event.entries);
  const texts = extractTextEntries(event.entries);
  const category =
    cats.find((c) => c.name === "category" || c.name === "type")?.value ||
    cats[0]?.value ||
    null;
  const duration = nums.find((n) => n.name === "duration" || n.unit === "min");
  const intensity = nums.find((n) => n.name === "intensity");
  const notes = texts.find((t) => t.name === "notes" || t.name === "note")?.value;

  const bits: string[] = ["Exercise"];
  if (category) bits.push(`(${category})`);
  const detail: string[] = [];
  if (duration) detail.push(`${duration.value}${duration.unit || "min"}`);
  if (intensity) detail.push(`intensity ${intensity.value}`);
  if (detail.length > 0) bits.push(detail.join(", "));
  let line = bits.join(" ") + ".";
  if (notes) line += ` ${notes}`;
  return line;
}

function renderTrackerText(event: LifeEventRecord): string {
  const label = humanize(event.subject_id);
  const texts = extractTextEntries(event.entries);
  const body = texts.map((t) => t.value).join("; ");
  return body ? `${label}: ${body}` : label + ".";
}

function buildPerDayNarrative(
  lifeEvents: LifeEventRecord[],
  cookingLog: RecipeEventRecord[],
  recipeNames: Map<string, string>,
  tz: string,
): string {
  // ISO day key -> ordered list of entries on that day.
  const byDay = new Map<string, DayEntry[]>();

  const push = (key: string, entry: DayEntry) => {
    const list = byDay.get(key) || [];
    list.push(entry);
    byDay.set(key, list);
  };

  for (const event of lifeEvents) {
    const key = localDayKey(event.timestamp, tz);
    if (event.subject_id === "morning_session") {
      push(key, { kind: "morning", event });
    } else if (event.subject_id === "evening_session") {
      push(key, { kind: "evening", event });
    } else if (event.subject_id === "weekly_review_session") {
      push(key, { kind: "weekly_review", event });
    } else {
      const kind = trackerNarrativeKind(event);
      if (kind) push(key, { kind, event } as DayEntry);
    }
  }

  for (const event of cookingLog) {
    const key = localDayKey(event.timestamp, tz);
    const recipeName =
      event.recipe_snapshot?.name ||
      recipeNames.get(event.subject_id) ||
      "Unknown recipe";
    push(key, { kind: "cooking", event, recipeName });
  }

  if (byDay.size === 0) {
    return "### Per-day narrative\n\nNo journal entries, cooking, or notable tracker events this period.\n";
  }

  // Render days in chronological order — reads like a journal.
  const sortedKeys = [...byDay.keys()].sort();

  const lines: string[] = ["### Per-day narrative\n"];

  // Custom render order within a day: morning → evening → weekly → cooking → exercise → tracker_text.
  // (Morning before evening matters; the rest is so the prose flows.)
  const orderRank: Record<DayEntry["kind"], number> = {
    morning: 0,
    evening: 1,
    weekly_review: 2,
    cooking: 3,
    exercise: 4,
    tracker_text: 5,
  };

  for (const key of sortedKeys) {
    const entries = byDay.get(key)!;
    entries.sort((a, b) => orderRank[a.kind] - orderRank[b.kind]);

    const dayLines: string[] = [];
    for (const entry of entries) {
      let rendered: string | null = null;
      if (entry.kind === "morning") rendered = renderMorningSession(entry.event);
      else if (entry.kind === "evening") rendered = renderEveningSession(entry.event);
      else if (entry.kind === "weekly_review") rendered = renderWeeklyReview(entry.event);
      else if (entry.kind === "cooking") rendered = renderCooking(entry.event, entry.recipeName);
      else if (entry.kind === "exercise") rendered = renderExercise(entry.event);
      else if (entry.kind === "tracker_text") rendered = renderTrackerText(entry.event);
      if (rendered) dayLines.push(rendered);
    }

    if (dayLines.length === 0) continue;
    lines.push(`**${formatDayHeading(key, tz)}**`);
    for (const line of dayLines) lines.push(line);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Activity summary (the operational stuff) ────────────────────────────────

function buildActivitySummary(
  lifeEvents: LifeEventRecord[],
  oneShotTasks: TaskRecord[],
  windowStart: Date,
  windowEnd: Date,
  tz: string,
): string {
  const lines: string[] = ["### Activity summary\n"];
  let hasContent = false;

  // Tracker aggregation: V2 from DATA_COLLECTION.md.
  // Bucket per (subjectId, localDay) first so 8 same-day floss events
  // count as one day with sum 8, not 8 events. Then aggregate across days.
  const trackerEvents = lifeEvents.filter((e) => !SESSION_SUBJECTS.includes(e.subject_id));
  if (trackerEvents.length > 0) {
    // subject -> day -> { count: number, sum: number, unit: string }
    const perDay = new Map<string, Map<string, { count: number; sum: number; unit: string }>>();
    for (const event of trackerEvents) {
      const day = localDayKey(event.timestamp, tz);
      const numerics = extractNumericEntries(event.entries);
      const subjectMap = perDay.get(event.subject_id) || new Map();
      const cell = subjectMap.get(day) || { count: 0, sum: 0, unit: "" };
      cell.count += 1;
      if (numerics.length > 0) {
        cell.sum += numerics.reduce((s, n) => s + n.value, 0);
        if (!cell.unit && numerics[0].unit) cell.unit = numerics[0].unit;
      }
      subjectMap.set(day, cell);
      perDay.set(event.subject_id, subjectMap);
    }

    const dayCount = Math.max(
      1,
      Math.ceil((windowEnd.getTime() - windowStart.getTime()) / (24 * 60 * 60 * 1000)),
    );

    const trackerLines: string[] = [];
    // Stable alphabetical ordering — deterministic output.
    const subjects = [...perDay.keys()].sort();
    for (const subject of subjects) {
      const subjectMap = perDay.get(subject)!;
      const daysWith = subjectMap.size;
      let totalEvents = 0;
      let totalSum = 0;
      let unit = "";
      for (const cell of subjectMap.values()) {
        totalEvents += cell.count;
        totalSum += cell.sum;
        if (!unit && cell.unit) unit = cell.unit;
      }
      const label = humanize(subject);
      const eventsLabel = totalEvents === 1 ? "1 event" : `${totalEvents} events`;
      const daysLabel = daysWith === 1 ? "1 day" : `${daysWith} days`;
      let line = `- ${label}: ${eventsLabel} across ${daysLabel}`;
      if (totalSum > 0) {
        const unitStr = unit ? ` ${unit}` : "";
        const avgPerDay = (totalSum / dayCount).toFixed(1);
        line += ` (total ${totalSum}${unitStr}, avg ${avgPerDay}${unitStr}/day)`;
      }
      trackerLines.push(line);
    }
    if (trackerLines.length > 0) {
      hasContent = true;
      lines.push("**Tracker totals:**");
      lines.push(...trackerLines);
      lines.push("");
    }
  }

  // One-shot task completions — narrative-shaped (trip prep, projects).
  if (oneShotTasks.length > 0) {
    hasContent = true;
    lines.push("**Completed projects/tasks (one-shot):**");
    for (const task of oneShotTasks) {
      lines.push(`- ${task.name}`);
    }
    lines.push("");
  }

  if (!hasContent) {
    return "### Activity summary\n\nNo tracker events or completed projects this period.\n";
  }

  return lines.join("\n");
}

// ─── Active context (travel + computable future signal) ──────────────────────

function buildActiveContext(
  trips: TripRecord[],
  activities: ActivityRecord[],
  windowEnd: Date,
  tz: string,
): string {
  if (trips.length === 0) {
    return "### Active context\n\nNo active or upcoming travel.\n";
  }

  const lines: string[] = ["### Active context\n"];

  for (const trip of trips) {
    const startDate = new Date(trip.start_date);
    const endDate = new Date(trip.end_date);
    const isUpcoming = startDate > windowEnd;
    const isActive = startDate <= windowEnd && endDate >= windowEnd;
    const status = isUpcoming ? "upcoming" : isActive ? "in progress" : "overlapping window";
    const tripStart = formatInTimeZone(startDate, tz, "MMM d");
    const tripEnd = formatInTimeZone(endDate, tz, "MMM d");

    lines.push(`**${trip.destination}** (${tripStart} – ${tripEnd}, ${status})`);

    const tripActivities = activities.filter((a) => a.trip_id === trip.id);
    if (tripActivities.length > 0) {
      const categories = new Map<string, string[]>();
      for (const a of tripActivities) {
        const cat = a.category || "Other";
        const existing = categories.get(cat) || [];
        existing.push(a.name);
        categories.set(cat, existing);
      }
      for (const [cat, names] of categories) {
        if (names.length <= 3) {
          lines.push(`- ${cat}: ${names.join(", ")}`);
        } else {
          lines.push(`- ${cat}: ${names.slice(0, 3).join(", ")} (+${names.length - 3} more)`);
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function assembleBundle(options: BundleOptions): Promise<BundleResult> {
  const { pb, windowStart, windowEnd } = options;
  const tz = safeTz(options.timezone, FALLBACK_TZ);

  // Fetch all data sources in parallel
  const [lifeEvents, cookingLog, completedTasks, travel] = await Promise.all([
    fetchLifeEvents(pb, windowStart, windowEnd),
    fetchCookingLog(pb, windowStart, windowEnd),
    fetchCompletedTasks(pb, windowStart, windowEnd),
    fetchActiveTravel(pb, windowStart, windowEnd),
  ]);

  // Batch-resolve recipe names for cooking events missing a snapshot.
  const recipeIds = [
    ...new Set(
      cookingLog
        .filter((e) => !e.recipe_snapshot?.name)
        .map((e) => e.subject_id),
    ),
  ];
  const recipeNames = await resolveRecipeNames(pb, recipeIds);

  // Suppress used-var warning for the recurring completions we deliberately
  // don't render. Kept available on the fetched payload for future view-layer
  // derivations (V5 days-since-last-X, etc.).
  void completedTasks.events;

  // Section 1 — header
  const header = `## Context window: ${formatDateRange(windowStart, windowEnd, tz)}\n`;

  // Section 2 — per-day narrative
  const perDay = buildPerDayNarrative(lifeEvents, cookingLog, recipeNames, tz);

  // Section 3 — activity summary
  const activity = buildActivitySummary(
    lifeEvents,
    completedTasks.tasks,
    windowStart,
    windowEnd,
    tz,
  );

  // Section 4 — active context (travel etc.)
  const context = buildActiveContext(travel.trips, travel.activities, windowEnd, tz);

  // Section 5 — footer (always shows the user-resolved tz)
  const footer = `*Times shown in ${tz}.*\n`;

  const markdown = [header, perDay, activity, context, footer].join("\n");

  // Collect related event IDs (life_events only — these link observations to source)
  const relatedEventIds = lifeEvents.map((e) => e.id);

  return { markdown, relatedEventIds };
}
