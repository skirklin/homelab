/**
 * Offline cache decorator for backends.
 *
 * Every backend now rides on the PBMirror, which supplies a richer
 * offline + optimistic story than the IDB hydrate-one decorator ever did:
 *
 *   - Optimistic mutations sit in MutationQueue and are persisted to IDB
 *     by wpb (`persistMutation` / `replayPending`).
 *   - The mirror's bootstrap and SSE event flow keep `queue.viewCollection`
 *     authoritative even across reconnects.
 *   - composeView reconciles server snapshots with pending mutations so a
 *     stale persisted SET can never override fresher server truth.
 *
 * The legacy hydrateOne path's failure mode (silent stale snapshot when
 * the live subscription fails to bootstrap — expired token, PB
 * unreachable, network blip) doesn't exist for the mirror: an offline
 * bootstrap simply emits the queue's prior-session state replayed via
 * wpb.replayPending, no pseudo-source-of-truth required.
 *
 * `withCache` is therefore a no-op pass-through today. Kept as the
 * public surface because callers import it; the per-domain decorators
 * (`withShoppingCache`, etc.) remain re-exported in case a callsite
 * still composes them manually.
 */

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
  // All backends are mirror-backed; the mirror subsumes the IDB
  // hydrate-first decorator. Pass-through preserves the existing call
  // sites (BackendProvider, etc.).
  return b;
}

export { cacheClear } from "./storage";
export { withShoppingCache } from "./shopping";
export { withUserCache } from "./user";
export { withLifeCache } from "./life";
export { withUpkeepCache } from "./upkeep";
export { withTravelCache } from "./travel";
export { withRecipesCache } from "./recipes";
