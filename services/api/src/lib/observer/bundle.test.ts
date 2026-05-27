/**
 * Unit tests for the observer bundle module.
 *
 * Mocks PocketBase to test bundle assembly logic without a real database.
 * Covers: empty period, text-heavy period, trip-imminent period, mixed period.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { assembleBundle, type BundleOptions } from "./bundle";

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
  return {
    id: `evening_${day}`,
    subject_id: "evening_session",
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T22:00:00Z`,
    entries,
    labels: null,
  };
}

function trackerEvent(id: string, subject: string, day: number, value: number, unit: string) {
  return {
    id,
    subject_id: subject,
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T19:00:00Z`,
    entries: [{ name: subject, type: "number", value, unit }],
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

function taskEvent(id: string, taskId: string, day: number) {
  return {
    id,
    subject_id: taskId,
    timestamp: `2026-05-${String(20 + day).padStart(2, "0")}T17:00:00Z`,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("assembleBundle", () => {
  describe("empty period", () => {
    it("produces valid markdown with nothing-logged notes", async () => {
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

      expect(result.markdown).toContain("Context window: May 20 – May 27, 2026");
      expect(result.markdown).toContain("No morning/evening sessions logged this period.");
      expect(result.markdown).toContain("No habits, cooking, or tasks logged this period.");
      expect(result.markdown).toContain("No active or upcoming travel.");
      expect(result.relatedEventIds).toEqual([]);
    });
  });

  describe("text-heavy period", () => {
    it("presents journal text day-by-day without summarizing", async () => {
      const lifeEvents = [
        morningSession(0, "Grateful for a good night of sleep", "Focus on the API refactor today"),
        eveningSession(0, "Shipped the observer module", "Need to take more breaks", "Yes, got the API refactor PR up"),
        morningSession(1, "The sunrise was beautiful", "Be present during conversations"),
        eveningSession(1, "Good dinner with friends", "Less screen time after 9pm"),
        morningSession(2, "Fresh coffee in the morning", "Write the bundle tests"),
        eveningSession(2, "Tests all passing", "Start earlier tomorrow"),
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

      // Verify text is presented, not summarized
      expect(result.markdown).toContain("Grateful for a good night of sleep");
      expect(result.markdown).toContain("Focus on the API refactor today");
      expect(result.markdown).toContain("Shipped the observer module");
      expect(result.markdown).toContain("Yes, got the API refactor PR up");
      expect(result.markdown).toContain("The sunrise was beautiful");
      expect(result.markdown).toContain("Be present during conversations");
      expect(result.markdown).toContain("Fresh coffee in the morning");
      expect(result.markdown).toContain("Tests all passing");

      // Verify day structure
      expect(result.markdown).toContain("**Wed, May 20**");
      expect(result.markdown).toContain("**Thu, May 21**");
      expect(result.markdown).toContain("**Fri, May 22**");

      // Verify session type labels
      expect(result.markdown).toContain("*morning:*");
      expect(result.markdown).toContain("*evening:*");

      // All 6 events should be in relatedEventIds
      expect(result.relatedEventIds).toHaveLength(6);
    });
  });

  describe("trip-imminent period", () => {
    it("includes upcoming trip in What's coming section", async () => {
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
      });

      expect(result.markdown).toContain("Tokyo, Japan");
      expect(result.markdown).toContain("upcoming");
      expect(result.markdown).toContain("Tsukiji Fish Market");
      expect(result.markdown).toContain("Meiji Shrine");
      expect(result.markdown).toContain("Mt. Takao");
      expect(result.markdown).toContain("Food & Dining");
      expect(result.markdown).toContain("Sightseeing");
      expect(result.markdown).toContain("Hiking");
    });
  });

  describe("mixed period", () => {
    it("assembles cross-source data from life events, cooking, and tasks", async () => {
      const lifeEvents = [
        morningSession(0, "Grateful for the weekend", "Cook something new"),
        trackerEvent("ex1", "exercise", 0, 45, "min"),
        trackerEvent("ex2", "exercise", 2, 30, "min"),
        trackerEvent("sleep1", "sleep", 1, 480, "min"),
        trackerEvent("coffee1", "coffee", 0, 8, "oz"),
        trackerEvent("coffee2", "coffee", 1, 12, "oz"),
      ];

      const cookingEvents = [
        cookingEvent("cook1", "recipe_abc", 1, "Pad Thai", "Used extra lime"),
        cookingEvent("cook2", "recipe_def", 3, "Chicken Tikka Masala"),
      ];

      const taskEvents = [
        taskEvent("te1", "task_123", 0),
        taskEvent("te2", "task_456", 2),
      ];

      const completedOneShotTasks = [
        { id: "task_789", name: "File taxes", completed: true, task_type: "one_shot", last_completed: null },
      ];

      const pb = createMockPb({
        life_events: { getFullList: vi.fn().mockResolvedValue(lifeEvents), getOne: vi.fn() },
        recipe_events: { getFullList: vi.fn().mockResolvedValue(cookingEvents), getOne: vi.fn() },
        task_events: { getFullList: vi.fn().mockResolvedValue(taskEvents), getOne: vi.fn() },
        tasks: {
          getFullList: vi.fn().mockResolvedValue(completedOneShotTasks),
          getOne: vi.fn().mockImplementation((id: string) => {
            const map: Record<string, { id: string; name: string }> = {
              task_123: { id: "task_123", name: "Review PR #42" },
              task_456: { id: "task_456", name: "Update deploy script" },
            };
            if (map[id]) return Promise.resolve(map[id]);
            return Promise.reject(new Error("not found"));
          }),
        },
        travel_trips: { getFullList: vi.fn().mockResolvedValue([]), getOne: vi.fn() },
      });

      const result = await assembleBundle({
        pb,
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        timezone: "America/Los_Angeles",
      });

      // Session text present
      expect(result.markdown).toContain("Grateful for the weekend");
      expect(result.markdown).toContain("Cook something new");

      // Habits summarized
      expect(result.markdown).toContain("exercise: 2x");
      expect(result.markdown).toContain("total: 75 min");
      expect(result.markdown).toContain("coffee: 2x");
      expect(result.markdown).toContain("sleep: 1x");

      // Cooking log
      expect(result.markdown).toContain("Pad Thai");
      expect(result.markdown).toContain("Used extra lime");
      expect(result.markdown).toContain("Chicken Tikka Masala");

      // Tasks
      expect(result.markdown).toContain("Review PR #42");
      expect(result.markdown).toContain("Update deploy script");
      expect(result.markdown).toContain("File taxes");

      // Related event IDs should include all life_events
      expect(result.relatedEventIds).toHaveLength(6);
      expect(result.relatedEventIds).toContain("morning_0");
      expect(result.relatedEventIds).toContain("ex1");
    });
  });
});
