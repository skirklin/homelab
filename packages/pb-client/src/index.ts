import PocketBase from "pocketbase";

export type { RecordModel, AuthRecord } from "pocketbase";
export { default as PocketBase } from "pocketbase";

// ============================================================
// Singleton client
// ============================================================

let pb: PocketBase | null = null;

export function initPocketBase(url: string): PocketBase {
  if (pb) return pb;
  pb = new PocketBase(url);
  return pb;
}

export function getPb(): PocketBase {
  if (!pb) throw new Error("PocketBase not initialized — call initPocketBase(url) first");
  return pb;
}

// ============================================================
// Collection names (avoid string typos)
// ============================================================

export const Collections = {
  // Groceries
  ShoppingLists: "shopping_lists",
  ShoppingItems: "shopping_items",
  ShoppingHistory: "shopping_history",
  ShoppingTrips: "shopping_trips",

  // Recipes
  RecipeBoxes: "recipe_boxes",
  Recipes: "recipes",
  RecipeEvents: "recipe_events",

  // Life
  LifeLogs: "life_logs",
  LifeEvents: "life_events",

  // Upkeep
  TaskLists: "task_lists",
  Tasks: "tasks",
  TaskEvents: "task_events",

  // Travel
  TravelLogs: "travel_logs",
  TravelTrips: "travel_trips",
  TravelActivities: "travel_activities",
  TravelItineraries: "travel_itineraries",
} as const;

// ============================================================
// Record types
// ============================================================

import type { RecordModel } from "pocketbase";

// Base type for all records
interface BaseRecord extends RecordModel {
  id: string;
  created: string;
  updated: string;
}

// --- Users ---
export interface UserRecord extends BaseRecord {
  email: string;
  name: string;
  avatar: string;
  shopping_slugs: Record<string, string> | null;
  household_slugs: Record<string, string> | null;
  travel_slugs: Record<string, string> | null;
  life_log_id: string;
  fcm_tokens: string[] | null;
  upkeep_notification_mode: "all" | "subscribed" | "off" | "";
  last_task_notification: string;
  recipe_boxes: unknown[] | null;
  cooking_mode_seen: boolean;
  last_seen_update_version: number;
}

// --- Groceries ---
export interface ShoppingListRecord extends BaseRecord {
  name: string;
  owners: string[];
  category_defs: Array<{ id: string; name: string }> | null;
}

export interface ShoppingItemRecord extends BaseRecord {
  list: string;
  ingredient: string;
  note: string;
  category_id: string;
  checked: boolean;
  added_by: string;
  checked_by: string;
  checked_at: string;
}

export interface ShoppingHistoryRecord extends BaseRecord {
  list: string;
  ingredient: string;
  category_id: string;
  last_added: string;
}

export interface ShoppingTripRecord extends BaseRecord {
  list: string;
  completed_at: string;
  items: Array<{ ingredient: string; note?: string; categoryId: string }> | null;
}

// --- Recipes ---
export interface RecipeBoxRecord extends BaseRecord {
  name: string;
  description: string;
  owners: string[];
  subscribers: string[];
  visibility: "private" | "public" | "unlisted";
  creator: string;
  last_updated_by: string;
}

export interface RecipeRecord extends BaseRecord {
  box: string;
  data: Record<string, unknown>;
  owners: string[];
  visibility: "private" | "public" | "unlisted";
  creator: string;
  last_updated_by: string;
  enrichment_status: "needed" | "pending" | "done" | "skipped" | "";
  pending_changes: Record<string, unknown> | null;
  step_ingredients: Record<string, string[]> | null;
  cooking_log: Array<{ madeAt: string; madeBy: string; note?: string }> | null;
}

// --- Events (shared shape) ---
export interface EventRecord extends BaseRecord {
  subject_id: string;
  timestamp: string;
  created_by: string;
  data: Record<string, unknown> | null;
}

export interface RecipeEventRecord extends EventRecord {
  box: string;
}

export interface LifeEventRecord extends EventRecord {
  log: string;
}

export interface TaskEventRecord extends EventRecord {
  list: string;
}

// --- Life ---
export interface LifeLogRecord extends BaseRecord {
  name: string;
  owners: string[];
  manifest: Record<string, unknown> | null;
  sample_schedule: Record<string, unknown> | null;
}

// --- Upkeep ---
export interface TaskListRecord extends BaseRecord {
  name: string;
  owners: string[];
  room_defs: Array<{ id: string; name: string }> | null;
}

export interface TaskRecord extends BaseRecord {
  list: string;
  name: string;
  description: string;
  room_id: string;
  frequency: { value: number; unit: "days" | "weeks" | "months" } | null;
  last_completed: string;
  snoozed_until: string;
  notify_users: string[];
  created_by: string;
}

// --- Travel ---
export interface TravelLogRecord extends BaseRecord {
  name: string;
  owners: string[];
  checklists: unknown[] | null;
}

export interface TravelTripRecord extends BaseRecord {
  log: string;
  destination: string;
  status: "Completed" | "Booked" | "Researching" | "Idea" | "Ongoing" | "";
  region: string;
  start_date: string;
  end_date: string;
  notes: string;
  source_refs: string;
  flagged_for_review: boolean;
  review_comment: string;
  checklist_done: Record<string, boolean> | null;
}

export interface TravelActivityRecord extends BaseRecord {
  log: string;
  name: string;
  category: string;
  location: string;
  place_id: string;
  lat: number;
  lng: number;
  description: string;
  cost_notes: string;
  duration_estimate: string;
  confirmation_code: string;
  details: string;
  setting: "outdoor" | "indoor" | "either" | "";
  booking_reqs: Array<{ daysBefore: number; action: string; done?: boolean }> | null;
  rating: number;
  rating_count: number;
  photo_ref: string;
  trip_id: string;
}

export interface TravelItineraryRecord extends BaseRecord {
  log: string;
  trip_id: string;
  name: string;
  is_active: boolean;
  days: Array<{
    date?: string;
    label: string;
    lodgingActivityId?: string;
    flights?: Array<{ activityId: string; startTime?: string; notes?: string }>;
    slots: Array<{ activityId: string; startTime?: string; notes?: string }>;
  }>;
}

// ============================================================
// Auth helpers
// ============================================================

export function isLoggedIn(): boolean {
  return getPb().authStore.isValid;
}

export function currentUser(): UserRecord | null {
  return (getPb().authStore.record as UserRecord) ?? null;
}

export async function loginWithGoogle(): Promise<UserRecord> {
  const result = await getPb().collection("users").authWithOAuth2({ provider: "google" });
  return result.record as UserRecord;
}

export async function logout(): Promise<void> {
  getPb().authStore.clear();
}
