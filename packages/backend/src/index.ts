/**
 * @homelab/backend — Backend abstraction layer.
 *
 * Defines interfaces for all app backends (auth, shopping, recipes, upkeep, travel, life).
 * Implementations live in separate files (pocketbase/, firebase/).
 * Apps import interfaces + factory functions, never backend-specific code.
 *
 * Usage:
 *   import { getAuthBackend, getShoppingBackend } from "@homelab/backend";
 *   const auth = getAuthBackend();
 *   const shopping = getShoppingBackend();
 */

// --- Types ---
export type { User, Unsubscribe, Visibility, NotificationMode } from "./types/common";
export type {
  ShoppingList, ShoppingItem, CategoryDef, ShoppingTrip,
} from "./types/shopping";
export type {
  RecipeBox, Recipe, RecipeData, RecipeInstruction, EnrichmentStatus,
  PendingChanges, CookingLogEvent,
} from "./types/recipes";
export type { TaskList, Task, TaskCompletion, Frequency, TaskType } from "./types/upkeep";
export type {
  TravelLog, Trip, Activity, ActivityVerdict, Itinerary, ItineraryDay,
  ActivitySlot, FlightSlot, FlightInfo,
  DayEntry,
} from "./types/travel";
export type { LifeLog, LifeEvent, LifeEntry, SampleSchedule } from "./types/life";
export type { LifeSampleQuestion, LifeRandomSamplesConfig } from "./types/life-config";
export { RANDOM_SAMPLES } from "./types/life-config";

// --- Upkeep urgency (canonical impl shared by upkeep UI + life morning header) ---
export {
  calculateDueDate,
  getUrgencyLevel,
  isTaskSnoozed,
} from "./lib/upkeep-urgency";
export type { UrgencyLevel, UrgencyTask } from "./lib/upkeep-urgency";

// --- Travel validation (canonical impl shared by travel UI + MCP server) ---
export {
  validateDay,
  parseTimeOfDay,
  parseDurationHours,
} from "./travel-validation";
export type {
  DayIssue,
  DayIssueKind,
  ValidationActivity,
  ValidationSlot,
} from "./travel-validation";

// --- Interfaces ---
export type { AuthBackend } from "./interfaces/auth";
export type { UserBackend, SlugNamespace } from "./interfaces/user";
export type { ShoppingBackend } from "./interfaces/shopping";
export type { RecipesBackend, RecipesUser } from "./interfaces/recipes";
export type { UpkeepBackend } from "./interfaces/upkeep";
export type { TravelBackend } from "./interfaces/travel";
export type { LifeBackend } from "./interfaces/life";
