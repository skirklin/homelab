/**
 * Unit tests for the observer bundle module.
 *
 * Mocks PocketBase to test bundle assembly logic without a real database.
 * Covers: empty period, text-heavy period, trip-imminent period,
 * mixed-types period.
 *
 * The bundle is structured as a V4 cross-source narrative:
 *   1. Period header
 *   2. Per-day narrative (interleaves journal text + cooking + tracker
 *      events that carry text/category context)
 *   3. Activity summary (aggregated tracker counts; one-shot tasks)
 *   4. Active context (travel)
 *   5. Footer (resolved tz)
 */
import { describe, it, expect, vi } from "vitest";
import { assembleBundle } from "./bundle";

// ─── Mock PocketBase ─────────────────────────────────────────────────────────

type FilterFn = (template: string, params: Record<string, unknown>) => string;

interface MockCollection {
  getFullList: ReturnType<typeof vi.fn>;
  getOne: ReturnType<typeof vi.fn>;
}

function createMockPb(collections: Record<string, MockCollection>) {
  const pb = {
    filter: ((template: string, _params: Record<string, unknown>) => template) as FilterFn,
    collection: (name: string) => {
      return collections[name] || {
        getFullList: vi.fn().mockResolvedValue([]),
        getOne: vi.fn().mockRejectedValue(new Error("not found")),
      };
    },
  };
  return pb as unknown as import("pocketbase").default;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Window: May 20–27 2026 UTC. America/Los_Angeles tz used in tests.
// Timestamps are UTC; the `day` offset is "how many days into the window"
// using a 14:00Z anchor — that lands in the morning Pacific so the local
// date matches `2026-05-(20+day)`.
const WINDOW_START = new Date("2026-05-20T07:00:00Z");
const WINDOW_END = new Date("2026-05-27T07:00:00Z");

function morningSession(day: number, gratitude: string, intention: string) {
  return {
    id: `morning_${day}`,
    subject_id: "morning_session",
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T14:00:00Z`,
    entries: [
      { name: "gratitude", type: "text", value: gratitude },
      { name: "intention", type: "text", value: intention },
      { name: "energy", type: "number", value: 4, unit: "rating" },
    ],
    labels: null,
  };
}

function eveningSession(day: number, win: string, lesson: string, intentionFollowup?: string) {
  const entries = [
    { name: "win", type: "text", value: win },
    { name: "lesson", type: "text", value: lesson },
    { name: "mood", type: "number", value: 4, unit: "rating" },
  ];
  if (intentionFollowup) {
    entries.unshift({ name: "intention_followup", type: "text", value: intentionFollowup });
  }
  // 22:00Z lands at 15:00 in LA on the same calendar date in the test window.
  return {
    id: `evening_${day}`,
    subject_id: "evening_session",
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T22:00:00Z`,
    entries,
    labels: null,
  };
}

function countTracker(id: string, subject: string, day: number, value: number, unit: string) {
  return {
    id,
    subject_id: subject,
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T19:00:00Z`,
    entries: [{ name: subject, type: "number", value, unit }],
    labels: null,
  };
}

function exerciseEvent(
  id: string,
  day: number,
  category: string,
  durationMin: number,
  intensity: number,
  notes?: string,
) {
  const entries: Array<{ name: string; type: string; value: unknown; unit?: string }> = [
    { name: "category", type: "category", value: category },
    { name: "duration", type: "number", value: durationMin, unit: "min" },
    { name: "intensity", type: "number", value: intensity, unit: "" },
  ];
  if (notes) entries.push({ name: "notes", type: "text", value: notes });
  return {
    id,
    subject_id: "exercise",
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T19:00:00Z`,
    entries,
    labels: null,
  };
}

function cookingEvent(id: string, recipeId: string, day: number, recipeName?: string, notes?: string) {
  const entries: Array<{ name: string; type: string; value: string }> = [];
  if (notes) entries.push({ name: "notes", type: "text", value: notes });
  return {
    id,
    subject_id: recipeId,
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T18:00:00Z`,
    entries,
    recipe_snapshot: recipeName ? { name: recipeName } : null,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("assembleBundle", () => {
  describe("empty period", () => {
    it("produces valid markdown with nothing-logged notes for each section", async () => {
      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Los_Angeles",
      });

      // Window: 07:00Z May 20 → 07:00Z May 27. In PDT (UTC-7) that's exactly
      // 00:00 on May 20 → 00:00 on May 27.
      expect(result.markdown).toContain("Context window: May 20 – May 27, 2026");

      // Per-day narrative empty state
      expect(result.markdown).toContain("### Per-day narrative");
      expect(result.markdown).toContain(
        "No journal entries, cooking, or notable tracker events this period.",
      );

      // Activity summary empty state
      expect(result.markdown).toContain("### Activity summary");
      expect(result.markdown).toContain("No tracker events or completed projects this period.");

      // Active context empty state
      expect(result.markdown).toContain("### Active context");
      expect(result.markdown).toContain("No active or upcoming travel.");

      // Footer uses the resolved tz (NOT "UTC")
      expect(result.markdown).toContain("Times shown in America/Los_Angeles");

      expect(result.relatedEventIds).toEqual([]);
    });

    it("falls back to America/Los_Angeles when timezone is missing", async () => {
      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        // no timezone — should fall back, not say "UTC"
      });

      expect(result.markdown).toContain("Times shown in America/Los_Angeles");
      expect(result.markdown).not.toContain("Times shown in UTC");
    });

    it("falls back to America/Los_Angeles when timezone is garbage", async () => {
      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "Not/AReal_Zone",
      });

      expect(result.markdown).toContain("Times shown in America/Los_Angeles");
    });
  });

  describe("text-heavy period", () => {
    it("interleaves morning + evening + cooking on the same day, in chronological order", async () => {
      const lifeEvents = [
        morningSession(0, "Grateful for a good night of sleep", "Focus on the API refactor today"),
        eveningSession(
          0,
          "Shipped the observer module",
          "Need to take more breaks",
          "Yes, got the API refactor PR up",
        ),
        morningSession(1, "The sunrise was beautiful", "Be present during conversations"),
        eveningSession(1, "Good dinner with friends", "Less screen time after 9pm"),
        morningSession(2, "Fresh coffee in the morning", "Write the bundle tests"),
        eveningSession(2, "Tests all passing", "Start earlier tomorrow"),
      ];

      const cookingEvents = [
        cookingEvent("cook_d0", "rid1", 0, "Ciabatta", "went badly, dough too wet"),
      ];

      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue(lifeEvents), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue(cookingEvents), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Los_Angeles",
      });

      // Text is presented verbatim
      expect(result.markdown).toContain("Grateful for a good night of sleep");
      expect(result.markdown).toContain("Focus on the API refactor today");
      expect(result.markdown).toContain("Shipped the observer module");
      expect(result.markdown).toContain("Yes, got the API refactor PR up");
      expect(result.markdown).toContain("The sunrise was beautiful");
      expect(result.markdown).toContain("Be present during conversations");
      expect(result.markdown).toContain("Fresh coffee in the morning");
      expect(result.markdown).toContain("Tests all passing");

      // Cooking interleaved on day 0
      expect(result.markdown).toContain("Cooked **Ciabatta**");
      expect(result.markdown).toContain("went badly, dough too wet");

      // Day headings use full weekday + month name (e.g. "Wednesday, May 20")
      expect(result.markdown).toMatch(/\*\*\w+day, May 20\*\*/);
      expect(result.markdown).toMatch(/\*\*\w+day, May 21\*\*/);
      expect(result.markdown).toMatch(/\*\*\w+day, May 22\*\*/);

      // Session labels are prose, not bulleted form
      expect(result.markdown).toContain("*Morning session.*");
      expect(result.markdown).toContain("*Evening session.*");
      // Old per-entry bullet format MUST be gone
      expect(result.markdown).not.toContain("- **gratitude:**");
      expect(result.markdown).not.toContain("- **win:**");

      // Day 0 ordering: morning text appears before evening text
      const dayBlock = result.markdown;
      const idxMorning = dayBlock.indexOf("Focus on the API refactor today");
      const idxEvening = dayBlock.indexOf("Shipped the observer module");
      const idxCooking = dayBlock.indexOf("Cooked **Ciabatta**");
      expect(idxMorning).toBeGreaterThan(-1);
      expect(idxEvening).toBeGreaterThan(idxMorning);
      expect(idxCooking).toBeGreaterThan(idxEvening);

      // Days appear oldest-first
      const idxDay20 = dayBlock.search(/\*\*\w+day, May 20\*\*/);
      const idxDay21 = dayBlock.search(/\*\*\w+day, May 21\*\*/);
      const idxDay22 = dayBlock.search(/\*\*\w+day, May 22\*\*/);
      expect(idxDay20).toBeLessThan(idxDay21);
      expect(idxDay21).toBeLessThan(idxDay22);

      // relatedEventIds covers the 6 life events
      expect(result.relatedEventIds).toHaveLength(6);
    });
  });

  describe("trip-imminent period", () => {
    it("includes upcoming trip in Active context section", async () => {
      const trips = [
        {
          id: "trip1",
          destination: "Tokyo, Japan",
          start_date: "2026-05-30",
          end_date: "2026-06-10",
          status: "planning",
        },
      ];

      const activities = [
        { id: "a1", trip_id: "trip1", name: "Tsukiji Fish Market", category: "Food & Dining", location: "Tokyo" },
        { id: "a2", trip_id: "trip1", name: "Meiji Shrine", category: "Sightseeing", location: "Tokyo" },
        { id: "a3", trip_id: "trip1", name: "Mt. Takao", category: "Hiking", location: "Tokyo" },
      ];

      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue(trips), getOne: vi.fn() },
        travel_activities: { getFullList: vi.fn().mockResolvedValue(activities), getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Los_Angeles",
      });

      expect(result.markdown).toContain("### Active context");
      expect(result.markdown).toContain("Tokyo, Japan");
      expect(result.markdown).toContain("upcoming");
      expect(result.markdown).toContain("Tsukiji Fish Market");
      expect(result.markdown).toContain("Meiji Shrine");
      expect(result.markdown).toContain("Mt. Takao");
      expect(result.markdown).toContain("Food & Dining");
      expect(result.markdown).toContain("Sightseeing");
      expect(result.markdown).toContain("Hiking");
    });

    it("batches travel_activities into a single PB query (not one per trip)", async () => {
      const trips = [
        { id: "t1", destination: "Tokyo", start_date: "2026-05-30", end_date: "2026-06-05", status: "planning" },
        { id: "t2", destination: "Kyoto", start_date: "2026-06-06", end_date: "2026-06-10", status: "planning" },
      ];
      const activitiesFn = vi.fn().mockResolvedValue([
        { id: "a1", trip_id: "t1", name: "Sushi", category: "Food & Dining", location: "Tokyo" },
        { id: "a2", trip_id: "t2", name: "Temple", category: "Culture", location: "Kyoto" },
      ]);
      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue(trips), getOne: vi.fn() },
        travel_activities: { getFullList: activitiesFn, getOne: vi.fn() },
      });

      await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Los_Angeles",
      });

      // One getFullList for activities, not two (no N+1)
      expect(activitiesFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("mixed-types period", () => {
    it("routes narrative content per-day and operational content into the summary", async () => {
      const lifeEvents = [
        // Day 0: journal + cooking + exercise w/ notes + plain count trackers
        morningSession(0, "Grateful for the weekend", "Cook something new"),
        eveningSession(0, "Made bread", "Patience with rising"),
        exerciseEvent("ex1", 0, "lift", 75, 5, "shoulders day, felt strong"),
        countTracker("coffee_d0_1", "coffee", 0, 8, "oz"),
        countTracker("coffee_d0_2", "coffee", 0, 6, "oz"), // same day → aggregated
        countTracker("floss_d0", "floss", 0, 1, ""),
        countTracker("poop_d0", "poop", 0, 1, ""),
        // Day 1: just count trackers — no narrative day should appear
        countTracker("coffee_d1", "coffee", 1, 12, "oz"),
        countTracker("floss_d1", "floss", 1, 1, ""),
        // Day 2: exercise (narrative)
        exerciseEvent("ex2", 2, "walk", 120, 2),
        countTracker("coffee_d2", "coffee", 2, 10, "oz"),
        // Day 3: only morning, no other narrative
        morningSession(3, "Quiet morning", "Read a chapter"),
      ];

      const cookingEvents = [
        cookingEvent("cook1", "recipe_abc", 1, "Pad Thai", "Used extra lime"),
        cookingEvent("cook2", "recipe_def", 3), // no snapshot → batch-resolved
      ];

      const completedOneShotTasks = [
        { id: "task_789", name: "File taxes", completed: true, task_type: "one_shot", last_completed: null },
        { id: "task_790", name: "Book Tokyo flight", completed: true, task_type: "one_shot", last_completed: null },
      ];

      const recipesGetFullList = vi
        .fn()
        .mockResolvedValue([{ id: "recipe_def", data: { name: "Chicken Tikka Masala" } }]);

      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue(lifeEvents), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue(cookingEvents), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue(completedOneShotTasks), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        recipes: { getFullList: recipesGetFullList, getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Los_Angeles",
      });

      // Per-day narrative INCLUDES the narrative-shaped stuff
      expect(result.markdown).toContain("Grateful for the weekend");
      expect(result.markdown).toContain("Made bread");
      expect(result.markdown).toContain("Exercise (lift)");
      expect(result.markdown).toContain("75min");
      expect(result.markdown).toContain("intensity 5");
      expect(result.markdown).toContain("shoulders day, felt strong");
      expect(result.markdown).toContain("Cooked **Pad Thai**");
      expect(result.markdown).toContain("Used extra lime");
      // Cooking on day 3 used the batch-resolved name
      expect(result.markdown).toContain("Cooked **Chicken Tikka Masala**");
      // Day 2 had narrative content (the walk)
      expect(result.markdown).toContain("Exercise (walk)");
      expect(result.markdown).toContain("120min");
      // Day 3 had morning only
      expect(result.markdown).toContain("Quiet morning");

      // Per-day narrative EXCLUDES plain count trackers
      // (must not appear in a day block; they belong to the activity summary)
      const perDaySection = result.markdown.split("### Activity summary")[0];
      expect(perDaySection).not.toMatch(/^- coffee:/m);
      expect(perDaySection).not.toMatch(/^- floss:/m);
      expect(perDaySection).not.toMatch(/^- poop:/m);

      // Day 1 had NO narrative-shaped life events (only count trackers + cooking
      // — wait, day 1 has a cooking event so day 1 IS shown). Confirm Pad Thai
      // appears under a Day 21 heading and not as a standalone bullet.
      // (Just check it's present in per-day section, since cooking is narrative.)
      expect(perDaySection).toContain("Cooked **Pad Thai**");

      // Activity summary: tracker aggregation
      const activitySection = result.markdown.split("### Activity summary")[1].split("### Active context")[0];
      expect(activitySection).toContain("Coffee: ");
      // coffee: 4 events, 8+6+12+10 = 36 oz
      expect(activitySection).toContain("total 36 oz");
      // floss: 2 events across 2 days
      expect(activitySection).toContain("Floss: 2 events across 2 days");
      // poop: 1 event across 1 day
      expect(activitySection).toContain("Poop: 1 event across 1 day");

      // Exercise also rolls up in the summary (it's a tracker too)
      expect(activitySection).toContain("Exercise: ");

      // Activity summary: one-shot tasks
      expect(activitySection).toContain("File taxes");
      expect(activitySection).toContain("Book Tokyo flight");

      // Batched recipe resolve was used — single getFullList, no per-id getOne
      expect(recipesGetFullList).toHaveBeenCalledTimes(1);

      // relatedEventIds covers every life event (sessions + trackers)
      expect(result.relatedEventIds.length).toBe(lifeEvents.length);
    });

    it("omits days with zero narrative-shaped activity", async () => {
      const lifeEvents = [
        // Day 0 narrative
        morningSession(0, "Good", "Ship the test"),
        // Day 1 only has count trackers — should NOT get a heading
        countTracker("coffee_d1", "coffee", 1, 8, "oz"),
        countTracker("floss_d1", "floss", 1, 1, ""),
        // Day 2 narrative again
        morningSession(2, "Back at it", "Review"),
      ];

      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue(lifeEvents), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        tasks: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
        travel_trips: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Los_Angeles",
      });

      const perDaySection = result.markdown.split("### Activity summary")[0];

      // Day 0 (May 20) and Day 2 (May 22) headings exist
      expect(perDaySection).toMatch(/\*\*\w+day, May 20\*\*/);
      expect(perDaySection).toMatch(/\*\*\w+day, May 22\*\*/);
      // Day 1 (May 21) does NOT get a heading — only had count trackers
      expect(perDaySection).not.toMatch(/\*\*\w+day, May 21\*\*/);
    });
  });
});

