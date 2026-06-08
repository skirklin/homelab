/**
 * Type declarations for authz-rules.js. The .js file is the source of
 * truth (consumed by PB migrations under goja, where TS isn't available);
 * this .d.ts is consumed only by the TS side.
 */

export interface CollectionRules {
  readonly listRule: string;
  readonly viewRule: string;
  readonly createRule: string;
  readonly updateRule: string;
  readonly deleteRule: string;
}

export type UserOwnedCollection =
  | "shopping_lists"
  | "shopping_items"
  | "shopping_trips"
  | "recipe_boxes"
  | "recipes"
  | "recipe_events"
  | "life_logs"
  | "life_events"
  | "claude_observations"
  | "chat_messages"
  | "coach_sessions"
  | "task_lists"
  | "tasks"
  | "task_events"
  | "travel_logs"
  | "travel_trips"
  | "travel_activities"
  | "travel_itineraries";

export const PB_RULES: Readonly<Record<UserOwnedCollection, CollectionRules>>;

export const OWNER_RULE: string;
export const BOX_VIS_RULE: string;
export const RECIPE_VIS_RULE: string;
export const RECIPE_WRITE_RULE: string;
export const LIFE_OWNER_RULE: string;
export const LIFE_CHILD_RULE: string;
