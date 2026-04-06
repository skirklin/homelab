/**
 * Firebase Cloud Functions entry point.
 *
 * All function implementations are organized into domain-specific modules:
 * - recipes/: Recipe scraping, generation, enrichment, and modification
 * - notifications/: Push notifications for upkeep and life tracker
 * - migrations/: One-time data migration functions
 *
 * Common utilities are in the utils/ directory:
 * - utils/ai.ts: Anthropic client, prompts, and response parsing
 * - utils/cors.ts: CORS configuration
 *
 * Firebase Admin SDK initialization is in firebase.ts.
 */

// Re-export all functions from modules
export {
  getRecipesFromPage,
  getRecipes,
  addRecipeOwner,
  addBoxOwner,
  getOwnerInfo,
  generateRecipe,
  enrichRecipeManual,
  modifyRecipe,
  enrichRecipes,
} from "./recipes";

export { sendHouseholdTaskNotifications } from "./notifications/upkeep";

export { sendLifeTrackerSamples } from "./notifications/life";

export {
  migrateCookingLogs,
  migrateLifeEntries,
  migrateUpkeepCompletions,
  backfillBoxSubscribers,
} from "./migrations";
