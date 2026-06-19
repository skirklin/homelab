/**
 * @homelab/backend — Backend abstraction layer.
 *
 * Defines interfaces for all app backends (shopping, recipes, upkeep, travel, life).
 * PocketBase implementations live under pocketbase/. Apps consume them via the
 * `BackendProvider` from `@kirkl/shared` and import interface types from here,
 * never backend-specific code.
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
  TravelNote,
} from "./types/travel";
export type {
  LifeLog, LifeEvent, LifeEntry, SampleSchedule,
  LifeManifest, LifeManifestTrackable, TrackableIdentity, TrackablePayload,
  TrackableShape, QuickPayload, TemplateRef,
  LifeGoal, GoalIdentity, GoalPayload, LifeGoalScope, LifeGoalKind, LifeGoalMetric,
  LifeView, ViewIdentity, ViewPayload, LifeViewItem, LifeNotification, LifeNotifyStrategy,
} from "./types/life";
export { DEFAULT_LIFE_MANIFEST, defaultLifeManifest } from "./life-manifest-default";
export {
  DEFAULT_VIEW_TRACKABLES,
  DEFAULT_VIEWS,
  DEFAULT_NOTIFICATIONS,
} from "./life-view-defaults";
export {
  normalizeSessionRuns,
  toNormalizerEvent,
  SESSION_SUBJECTS,
  SESSION_VIEW,
  SESSION_ID_MAP,
  RATED_NEW_IDS,
} from "./life-session-runs";
export type {
  SessionRun,
  RunItem,
  SessionSubject,
  SessionView,
  NormalizerEvent,
} from "./life-session-runs";
export {
  ManifestError,
  TRACKABLE_SHAPES,
  isSlug,
  slugifyTrackableId,
  validateOptionalString,
  patchOptionalString,
  reorderById,
  validatePins,
  emptyManifest,
  addTrackable,
  updateTrackable,
  removeTrackable,
  reorderTrackables,
  setPins,
} from "./life-manifest-ops";
export type { ManifestErrorCode } from "./life-manifest-ops";
export {
  addGoal,
  updateGoal,
  removeGoal,
  reorderGoals,
  manifestGoals,
  GOAL_KINDS,
  GOAL_METRICS,
  GOAL_PERIODS,
} from "./life-goal-ops";
export {
  addView,
  updateView,
  removeView,
  reorderViews,
  manifestViews,
  addNotification,
  updateNotification,
  removeNotification,
  reorderNotifications,
  manifestNotifications,
  VIEW_ITEM_KINDS,
  VIEW_RENDERS,
  NOTIFY_KINDS,
  NOTIFY_CADENCES,
} from "./life-view-ops";
export { evaluateGoal, startOfDay, endOfDay, dayKey, startOfWeek, zonedDateTime } from "./life-goal-eval";
export type { GoalProgress } from "./life-goal-eval";
export type {
  AddTrackableInput, UpdateTrackablePatch, AddGoalInput, UpdateGoalPatch,
  AddViewInput, UpdateViewPatch, AddNotificationInput, UpdateNotificationPatch,
} from "./interfaces/life";
export type { ClaudeObservation } from "./types/observer";
export type {
  ChatMessage,
  ChatMessageRole,
  ChatMessageKind,
} from "./types/chat";
export type { LifeSampleQuestion, LifeRandomSamplesConfig } from "./types/life-config";
export { RANDOM_SAMPLES } from "./types/life-config";

// --- Upkeep urgency (canonical impl shared by upkeep UI + life morning header) ---
export {
  calculateDueDate,
  daysUntilDue,
  getUrgencyLevel,
  isTaskSnoozed,
  isActionableOneShot,
} from "./lib/upkeep-urgency";
export type { UrgencyLevel, UrgencyTask } from "./lib/upkeep-urgency";

// --- Assignee resolution (client mirror of server resolveNotifyRecipients) ---
export { resolveAssignees } from "./lib/assignee-resolution";
export type { AssigneeNode, ResolvedAssignees } from "./lib/assignee-resolution";

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
export type { UserBackend, SlugNamespace, PushSubscriptionInfo } from "./interfaces/user";
export type { ShoppingBackend } from "./interfaces/shopping";
export type { RecipesBackend, RecipesUser } from "./interfaces/recipes";
export type { UpkeepBackend } from "./interfaces/upkeep";
export type { TravelBackend } from "./interfaces/travel";
export type { LifeBackend } from "./interfaces/life";
export type { ObserverBackend } from "./interfaces/observer";
export type {
  ChatBackend,
  ListChatMessagesOptions,
  PostChatMessageInput,
} from "./interfaces/chat";
