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
export type { User, Unsubscribe, Event, Visibility, NotificationMode } from "./types/common";
export type {
  ShoppingList, ShoppingItem, CategoryDef, HistoryEntry, ShoppingTrip,
} from "./types/shopping";
export type {
  RecipeBox, Recipe, RecipeData, RecipeInstruction, EnrichmentStatus,
  PendingChanges, CookingLogEvent,
} from "./types/recipes";
export type { TaskList, Task, TaskCompletion, Frequency, TaskType } from "./types/upkeep";
export type {
  TravelLog, Trip, Activity, Itinerary, ItineraryDay,
  ActivitySlot, FlightSlot, ChecklistTemplate, ChecklistItem,
} from "./types/travel";
export type { LifeLog, LifeManifest, WidgetConfig, LifeEntry } from "./types/life";

// --- Interfaces ---
export type { AuthBackend } from "./interfaces/auth";
export type { UserBackend, SlugNamespace } from "./interfaces/user";
export type { ShoppingBackend } from "./interfaces/shopping";
export type { RecipesBackend, RecipesUser } from "./interfaces/recipes";
export type { UpkeepBackend } from "./interfaces/upkeep";
export type { TravelBackend } from "./interfaces/travel";
export type { LifeBackend } from "./interfaces/life";
