import { User } from 'firebase/auth';
import { DocumentReference, Timestamp, Unsubscribe } from 'firebase/firestore';
import { Comment, Recipe } from 'schema-dts';
import { BoxEntry, RecipeEntry, UserEntry } from './storage';

export type BoxId = string
export type RecipeId = string
export type UserId = string

export type BoxType = {
  name: string,
  description?: string,
}

export type BoxStoreType = {
  creator: string,
  owners: string[], // user ids
  visibility: Visibility,
  created: Timestamp,
  updated: Timestamp,
  lastUpdatedBy: string, // user id
  data: BoxType
}

export type PendingEnrichment = {
  description: string,
  suggestedTags: string[],
  reasoning: string,
  generatedAt: Timestamp,
  model: string,
}

export type CookingLogEntry = {
  madeAt: Date,
  madeBy: string,  // UserId
  note?: string,
}

export type CookingLogEntryStore = {
  madeAt: Timestamp,
  madeBy: string,
  note?: string,
}

export type RecipeStoreType = {
  creator: string,
  data: Recipe,
  visibility: Visibility,
  created: Timestamp,
  updated: Timestamp,
  lastUpdatedBy: string, // user id
  owners: string[], // user ids
  pendingEnrichment?: PendingEnrichment,
  cookingLog?: CookingLogEntryStore[],
  enrichmentStatus?: EnrichmentStatus,
}

export type UserStoreType = {
  name: string,
  visibility: Visibility,
  lastSeen: Timestamp,
  newSeen: Timestamp,
  boxes: DocumentReference<BoxEntry>[],
  cookingModeSeen?: boolean,
  lastSeenUpdateVersion?: number,
}

export type AppState = {
  boxes: Map<string, BoxEntry>
  users: Map<string, UserEntry>
  authUser: User | null
  writeable: boolean
  loading: number
  subscriptionsReady: boolean  // true once initial subscription loading completes
}

export type ActionType = {
  type: string
  recipeId?: RecipeId
  recipe?: RecipeEntry
  boxId?: BoxId
  box?: BoxEntry
  userId?: UserId
  user?: UserEntry
  authUser?: User | null
  payload?: RecipeEntry
  | BoxEntry
  | Map<string, BoxEntry>
  | Map<string, RecipeEntry>
  | boolean
  | string
  | Recipe["recipeIngredient"]
  | Recipe["recipeInstructions"]
  | Recipe["recipeCategory"]
  | Recipe["author"]
  | Comment
}

export type UnsubMap = {
  userUnsub: Unsubscribe | undefined,
  boxesUnsub: Unsubscribe | undefined,
  boxMap: Map<string, {
    boxUnsub: Unsubscribe | undefined,
    recipesUnsub: Unsubscribe | undefined,
  }>
}

export enum Visibility {
  private = "private", // only owner can read
  // linkable = "linkable", // anyone with link can read
  public = "public", // discoverable
}

export enum EnrichmentStatus {
  needed = "needed",     // newly created/edited, needs AI processing
  pending = "pending",   // AI generated suggestions, waiting for user review
  done = "done",         // user accepted enrichment
  skipped = "skipped",   // user rejected or recipe already had content
}