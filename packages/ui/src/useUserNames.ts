import { useEffect, useState } from "react";
import { useUserBackend } from "./backend-provider";
import { useAuth } from "./auth";

// Shared across all hook instances. Display names are low-churn; staleness
// until reload is acceptable.
const nameCache = new Map<string, string>();
const inflight = new Set<string>();

/**
 * Resolve a set of user IDs to display names. Returns a Map of id -> name,
 * omitting IDs that haven't resolved (yet or ever). Re-renders the caller
 * when newly-fetched names arrive. Backed by the `user_names` view via
 * UserBackend.resolveNames — exposes only names, no PII.
 */
export function useUserNames(
  ids: ReadonlyArray<string | undefined | null>,
): Map<string, string> {
  const userBackend = useUserBackend();
  const { user } = useAuth();
  const [, bump] = useState(0);

  const wanted = Array.from(
    new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0)),
  );
  // The current user is known from auth — never fetch them.
  const missing = wanted.filter(
    (id) => id !== user?.uid && !nameCache.has(id) && !inflight.has(id),
  );
  const missingKey = missing.join(",");

  useEffect(() => {
    if (!user || missing.length === 0) return;
    missing.forEach((id) => inflight.add(id));
    let cancelled = false;
    userBackend
      .resolveNames(missing)
      .then((rows) => {
        const found = new Set<string>();
        for (const r of rows) {
          nameCache.set(r.id, r.name || "");
          found.add(r.id);
        }
        // Cache a definitive empty for IDs the view didn't return so we don't
        // refetch genuinely-absent users every render.
        for (const id of missing) if (!found.has(id)) nameCache.set(id, "");
      })
      .catch(() => {
        // Transient failure: leave out of cache so a later mount retries.
      })
      .finally(() => {
        missing.forEach((id) => inflight.delete(id));
        if (!cancelled) bump((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey, userBackend, user?.uid]);

  const out = new Map<string, string>();
  for (const id of wanted) {
    if (user && id === user.uid) {
      out.set(id, user.name);
      continue;
    }
    const n = nameCache.get(id);
    if (n) out.set(id, n);
  }
  return out;
}
