/**
 * Offline cache decorator for backends.
 *
 * Usage:
 *   import { createPocketBaseBackends } from "@homelab/backend/pocketbase";
 *   import { withCache } from "@homelab/backend/cache";
 *   const backends = withCache(createPocketBaseBackends(() => getPb()));
 *
 * Reads are served from IndexedDB while offline; writes pass through and
 * will reject when the network is unavailable. Subscriptions hydrate from
 * cache immediately, then overlay live PocketBase updates as they arrive.
 *
 * SHOPPING IS DELIBERATELY UNWRAPPED HERE. The PBMirror that backs the
 * shopping backend supplies its own offline + optimistic story:
 *   - Optimistic mutations sit in MutationQueue and are persisted to IDB
 *     by wpb (`persistMutation` / `replayPending`).
 *   - The mirror's bootstrap and SSE event flow keep `queue.viewCollection`
 *     authoritative even across reconnects.
 *   - composeView reconciles server snapshots with pending mutations so a
 *     stale persisted SET can never override fresher server truth (commit
 *     2f4c2e4).
 *
 * The cache decorator's hydrateOne path adds a parallel "deliver a stale
 * snapshot first, hope the mirror overrides it" mechanism. That's fine in
 * the happy path. The failure mode (shopping.test.ts: REPRO suspected user
 * bug) is that if the mirror's bootstrap silently fails — expired token,
 * PB unreachable, network blip — the hydrateOne emit is the ONLY thing the
 * reducer ever sees, and the user is left looking at the pre-toggle state
 * forever. The mirror has no equivalent failure mode: an offline bootstrap
 * leaves the queue's prior-session state (replayed via wpb.replayPending)
 * visible to consumers, no stale-snapshot pseudo-source-of-truth required.
 *
 * Other backends still need the cache decorator because they use the
 * legacy wpb.subscribe path; they should migrate to the mirror over time
 * (then unwrap from withCache as they do).
 */
import { withTravelCache } from "./travel";
import { withUpkeepCache } from "./upkeep";
import { withRecipesCache } from "./recipes";
import { withLifeCache } from "./life";

import type { TravelBackend } from "../interfaces/travel";
import type { ShoppingBackend } from "../interfaces/shopping";
import type { UpkeepBackend } from "../interfaces/upkeep";
import type { RecipesBackend } from "../interfaces/recipes";
import type { LifeBackend } from "../interfaces/life";
import type { UserBackend } from "../interfaces/user";

export interface BackendBundle {
  travel: TravelBackend;
  shopping: ShoppingBackend;
  upkeep: UpkeepBackend;
  recipes: RecipesBackend;
  life: LifeBackend;
  user: UserBackend;
}

export function withCache(b: BackendBundle): BackendBundle {
  return {
    travel: withTravelCache(b.travel),
    // shopping is on the mirror — see file comment for why we skip caching.
    shopping: b.shopping,
    upkeep: withUpkeepCache(b.upkeep),
    recipes: withRecipesCache(b.recipes),
    life: withLifeCache(b.life),
    // user is on the mirror; subscribeSlugs is queue-overlay-aware and
    // the read-only helpers (getProfile, etc.) hit the network directly.
    user: b.user,
  };
}

export { cacheClear } from "./storage";
export { withShoppingCache } from "./shopping";
export { withUserCache } from "./user";
export {
  withTravelCache,
  withUpkeepCache,
  withRecipesCache,
  withLifeCache,
};
