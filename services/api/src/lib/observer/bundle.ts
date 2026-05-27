/**
 * View-layer bundle module for the AI observer.
 *
 * Assembles a cross-source narrative document from the user's data for a
 * given time window. Output is markdown prose intended as context for the
 * Anthropic API. See apps/life/OBSERVER_BUILD_PLAN.md (P0-2) and
 * apps/life/DATA_COLLECTION.md for design philosophy.
 *
 * Design principles:
 * - Text fields are king. Journal entries carry almost all signal.
 * - Don't summarize — present. The LLM finds its own patterns.
 * - Cross-source joins are the bundle's job.
 * - Empty is fine. Say so briefly, don't pad.
 */
import type PocketBase from "pocketbase";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SESSION_SUBJECTS = ["morning_session", "evening_session", "weekly_review_session"];

function formatDate(isoStr: string, tz?: string): string {
  const date = new Date(isoStr);
  if (tz) {
    return format(toZonedTime(date, tz), "EEE, MMM d");
  }
  return format(date, "EEE, MMM d");
}

function formatDateRange(start: Date, end: Date, tz?: string): string {
  const s = tz ? toZonedTime(start, tz) : start;
  const e = tz ? toZonedTime(end, tz) : end;
  return `${format(s, "MMM d")} – ${format(e, "MMM d, yyyy")}`;
}

function extractTextEntries(
  entries: Array<{ name: string; type: string; value: unknown }>,
): Array<{ name: string; value: string }> {
  return entries
    .filter((e) => e.type === "text" && typeof e.value === "string" && (e.value as string).trim())
    .map((e) => ({ name: e.name, value: e.value as string }));
}

function extractNumericEntries(
  entries: Array<{ name: string; type: string; value: unknown; unit?: string }>,
): Array<{ name: string; value: number; unit: string }> {
  return entries
    .filter((e) => e.type === "number" && typeof e.value === "number")
    .map((e) => ({ name: e.name, value: e.value as number, unit: e.unit || "" }));
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
    // Get task completion events in the window
    const events = await pb.collection("task_events").getFullList<TaskEventRecord>({
      filter: pb.filter(
        "timestamp >= {:start} && timestamp <= {:end}",
        { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      ),
      sort: "timestamp",
    });

    // Also get one-shot tasks completed in the window (they don't use task_events)
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

    // Fetch activities for relevant trips
    const tripIds = trips.map((t) => t.id);
    const activities: ActivityRecord[] = [];
    for (const tripId of tripIds) {
      try {
        const tripActivities = await pb.collection("travel_activities").getFullList<ActivityRecord>({
          filter: pb.filter("trip_id = {:tripId}", { tripId }),
        });
        activities.push(...tripActivities);
      } catch {
        // Skip if trip activities can't be fetched
      }
    }

    return { trips, activities };
  } catch {
    return { trips: [], activities: [] };
  }
}

async function resolveTaskNames(
  pb: PocketBase,
  taskIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (taskIds.length === 0) return nameMap;

  // Batch-fetch task records to get names
  for (const id of taskIds) {
    try {
      const task = await pb.collection("tasks").getOne<TaskRecord>(id);
      nameMap.set(id, task.name);
    } catch {
      // Task may have been deleted
    }
  }
  return nameMap;
}

async function resolveRecipeNames(
  pb: PocketBase,
  recipeIds: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (recipeIds.length === 0) return nameMap;

  for (const id of recipeIds) {
    try {
      const recipe = await pb.collection("recipes").getOne<{ id: string; data: { name?: string } }>(id);
      if (recipe.data?.name) nameMap.set(id, recipe.data.name);
    } catch {
      // Recipe may have been deleted
    }
  }
  return nameMap;
}

// ─── Section builders ────────────────────────────────────────────────────────

function buildWhatYouWroteSection(
  events: LifeEventRecord[],
  tz?: string,
): string {
  const sessionEvents = events.filter((e) => SESSION_SUBJECTS.includes(e.subject_id));

  if (sessionEvents.length === 0) {
    return "### What you wrote\n\nNo morning/evening sessions logged this period.\n";
  }

  // Group by day
  const byDay = new Map<string, LifeEventRecord[]>();
  for (const event of sessionEvents) {
    const dayKey = formatDate(event.timestamp, tz);
    const existing = byDay.get(dayKey) || [];
    existing.push(event);
    byDay.set(dayKey, existing);
  }

  const lines: string[] = ["### What you wrote\n"];

  for (const [day, dayEvents] of byDay) {
    lines.push(`**${day}**\n`);

    for (const event of dayEvents) {
      const sessionType = event.subject_id.replace("_session", "");
      const textEntries = extractTextEntries(event.entries);

      if (textEntries.length === 0) continue;

      lines.push(`*${sessionType}:*`);
      for (const entry of textEntries) {
        const label = entry.name.replace(/_/g, " ");
        lines.push(`- **${label}:** ${entry.value}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function buildWhatYouDidSection(
  events: LifeEventRecord[],
  cookingLog: RecipeEventRecord[],
  completedTasks: { tasks: TaskRecord[]; events: TaskEventRecord[] },
  taskNames: Map<string, string>,
  recipeNames: Map<string, string>,
  tz?: string,
): string {
  const lines: string[] = ["### What you did\n"];
  let hasContent = false;

  // Habits and trackers (non-session life events)
  const trackerEvents = events.filter((e) => !SESSION_SUBJECTS.includes(e.subject_id));
  if (trackerEvents.length > 0) {
    hasContent = true;
    // Group by subject_id and summarize
    const bySubject = new Map<string, LifeEventRecord[]>();
    for (const event of trackerEvents) {
      const existing = bySubject.get(event.subject_id) || [];
      existing.push(event);
      bySubject.set(event.subject_id, existing);
    }

    lines.push("**Tracked habits:**");
    for (const [subject, subjectEvents] of bySubject) {
      const label = subject.replace(/_/g, " ");
      const numerics = subjectEvents.flatMap((e) => extractNumericEntries(e.entries));
      if (numerics.length > 0) {
        const total = numerics.reduce((sum, n) => sum + n.value, 0);
        const unit = numerics[0].unit;
        lines.push(`- ${label}: ${subjectEvents.length}x (total: ${total}${unit ? " " + unit : ""})`);
      } else {
        lines.push(`- ${label}: ${subjectEvents.length}x`);
      }
    }
    lines.push("");
  }

  // Cooking
  if (cookingLog.length > 0) {
    hasContent = true;
    lines.push("**Cooking:**");
    for (const event of cookingLog) {
      const recipeName =
        event.recipe_snapshot?.name ||
        recipeNames.get(event.subject_id) ||
        "Unknown recipe";
      const dateStr = formatDate(event.timestamp, tz);
      const notes = extractTextEntries(event.entries);
      const notesStr = notes.length > 0 ? ` — ${notes[0].value}` : "";
      lines.push(`- ${recipeName} (${dateStr})${notesStr}`);
    }
    lines.push("");
  }

  // Tasks completed
  const allTaskCompletions: Array<{ name: string; date: string }> = [];

  // From task_events (recurring completions)
  for (const event of completedTasks.events) {
    const name = taskNames.get(event.subject_id) || event.subject_id;
    allTaskCompletions.push({ name, date: formatDate(event.timestamp, tz) });
  }

  // From one-shot tasks marked complete
  for (const task of completedTasks.tasks) {
    allTaskCompletions.push({ name: task.name, date: "" });
  }

  if (allTaskCompletions.length > 0) {
    hasContent = true;
    lines.push("**Tasks completed:**");
    for (const task of allTaskCompletions) {
      const dateStr = task.date ? ` (${task.date})` : "";
      lines.push(`- ${task.name}${dateStr}`);
    }
    lines.push("");
  }

  if (!hasContent) {
    return "### What you did\n\nNo habits, cooking, or tasks logged this period.\n";
  }

  return lines.join("\n");
}

function buildWhatsComingSection(
  trips: TripRecord[],
  activities: ActivityRecord[],
  windowEnd: Date,
  tz?: string,
): string {
  if (trips.length === 0) {
    return "### What's coming\n\nNo active or upcoming travel.\n";
  }

  const lines: string[] = ["### What's coming\n"];

  for (const trip of trips) {
    const startDate = new Date(trip.start_date);
    const endDate = new Date(trip.end_date);
    const isUpcoming = startDate > windowEnd;
    const isActive = startDate <= windowEnd && endDate >= windowEnd;

    const status = isUpcoming ? "upcoming" : isActive ? "in progress" : "overlapping window";
    const tripStart = tz
      ? format(toZonedTime(startDate, tz), "MMM d")
      : format(startDate, "MMM d");
    const tripEnd = tz
      ? format(toZonedTime(endDate, tz), "MMM d")
      : format(endDate, "MMM d");

    lines.push(`**${trip.destination}** (${tripStart} – ${tripEnd}, ${status})`);

    // List key activities for this trip
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
  const { pb, windowStart, windowEnd, timezone } = options;

  // Fetch all data sources in parallel
  const [lifeEvents, cookingLog, completedTasks, travel] = await Promise.all([
    fetchLifeEvents(pb, windowStart, windowEnd),
    fetchCookingLog(pb, windowStart, windowEnd),
    fetchCompletedTasks(pb, windowStart, windowEnd),
    fetchActiveTravel(pb, windowStart, windowEnd),
  ]);

  // Resolve names for tasks and recipes (needs IDs from the fetched data)
  const taskIds = [...new Set(completedTasks.events.map((e) => e.subject_id))];
  const recipeIds = [...new Set(
    cookingLog
      .map((e) => e.subject_id)
      .filter((id) => !cookingLog.find((e) => e.subject_id === id && e.recipe_snapshot?.name)),
  )];

  const [taskNames, recipeNames] = await Promise.all([
    resolveTaskNames(pb, taskIds),
    resolveRecipeNames(pb, recipeIds),
  ]);

  // Build sections
  const header = `## Context window: ${formatDateRange(windowStart, windowEnd, timezone)}\n`;
  const tzNote = timezone
    ? `*Times shown in ${timezone}.*\n`
    : "*Times shown in UTC.*\n";

  const whatYouWrote = buildWhatYouWroteSection(lifeEvents, timezone);
  const whatYouDid = buildWhatYouDidSection(
    lifeEvents, cookingLog, completedTasks, taskNames, recipeNames, timezone,
  );
  const whatsComing = buildWhatsComingSection(
    travel.trips, travel.activities, windowEnd, timezone,
  );

  const markdown = [header, tzNote, whatYouWrote, whatYouDid, whatsComing].join("\n");

  // Collect related event IDs (life_events only — these link observations to source)
  const relatedEventIds = lifeEvents.map((e) => e.id);

  return { markdown, relatedEventIds };
}
