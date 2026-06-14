/**
 * Shared, data-source-agnostic helpers for the life-app ingest endpoints
 * (Health Connect at /health/ingest, screen-time at /screentime/ingest, …).
 *
 * Everything here is about WRITING into the caller's own `life_events` /
 * `life_logs` safely and idempotently, independent of which feed produced the
 * data:
 *   - resolving the caller's own life log (no caller-supplied log id, so
 *     cross-user writes are structurally impossible),
 *   - the deterministic `source_id` dedup lookup,
 *   - the optimistic, append-only manifest trackable-ensure (parameterized by
 *     a list of specs so each feed declares its own trackables),
 *   - PB unique-violation classification (so a lost create-race is handled
 *     gracefully instead of 500ing),
 *   - small numeric utils.
 *
 * Both ingest mappers import from here; neither owns a private copy.
 */
import type PocketBase from "pocketbase";
import { ClientResponseError } from "pocketbase";

/** Round to `digits` decimal places. */
export function round(value: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** A finite number, or null (rejects non-numbers, NaN, Infinity). */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * True iff `err` is a PocketBase unique-index/constraint violation: a 400
 * ClientResponseError whose field-level validation map reports
 * `validation_not_unique` (PB's code for a UNIQUE-index conflict). Used so a
 * concurrent / client-retried insert that loses the create race is handled
 * gracefully (treat-as-exists) instead of 500ing — WITHOUT blanket-swallowing
 * unrelated errors, which must still propagate.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof ClientResponseError)) return false;
  if (err.status !== 400) return false;
  // PB shape: { data: { data: { <field>: { code: "validation_not_unique" } } } }
  const fields = (err.response as { data?: Record<string, { code?: string }> } | undefined)?.data;
  if (fields && typeof fields === "object") {
    for (const k of Object.keys(fields)) {
      if (fields[k]?.code === "validation_not_unique") return true;
    }
  }
  return false;
}

/** A trackable row an ingest mapper ensures exists before writing. */
export type EnsureSpec = {
  id: string;
  label: string;
  shape: "took" | "did";
  group?: string;
  defaultUnit?: string;
};

type ManifestTrackable = { id: string; shape: string; [k: string]: unknown };
type Manifest = { trackables: ManifestTrackable[]; goals?: unknown[] };

/** Coerce a PB manifest JSON value into a Manifest, defaulting to empty. */
function manifestOf(raw: unknown): Manifest {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const m = raw as Record<string, unknown>;
    if (Array.isArray(m.trackables)) {
      return {
        trackables: m.trackables as ManifestTrackable[],
        goals: Array.isArray(m.goals) ? (m.goals as unknown[]) : undefined,
      };
    }
  }
  return { trackables: [] };
}

/** Resolve the caller's OWN life log, creating it if absent. */
export async function getOrCreateOwnLifeLog(pb: PocketBase, userId: string) {
  const logs = await pb.collection("life_logs").getList(1, 1, {
    filter: pb.filter("owner = {:uid}", { uid: userId }),
    sort: "created",
  });
  if (logs.items.length > 0) return logs.items[0];
  return pb.collection("life_logs").create({ name: "Life Log", owner: userId });
}

/**
 * Append any still-missing `specs` to the log's manifest, append-only, with
 * optimistic concurrency. PocketBase has no native row-version guard, so we
 * re-read the manifest each attempt, append only ids that are STILL missing
 * (never touching existing trackables or goals), update, then VERIFY by
 * re-reading that our appended ids survived. If a concurrent writer clobbered
 * them (lost-update), we retry against the now-fresh manifest. After
 * `maxAttempts` we propagate (fail loud) rather than risk a silent overwrite.
 *
 * `log` is the already-fetched record; we re-fetch inside the loop so the first
 * attempt also works off the freshest read.
 */
export async function ensureTrackables(
  pb: PocketBase,
  log: { id: string },
  specs: EnsureSpec[],
  maxAttempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const fresh = await pb.collection("life_logs").getOne(log.id);
    const manifest = manifestOf(fresh.manifest);
    const existingIds = new Set(manifest.trackables.map((t) => t.id));
    const missing = specs.filter((s) => !existingIds.has(s.id));
    if (missing.length === 0) return; // nothing to do — already converged
    for (const spec of missing) {
      const t: ManifestTrackable = { id: spec.id, label: spec.label, shape: spec.shape };
      if (spec.group) t.group = spec.group;
      if (spec.defaultUnit) t.defaultUnit = spec.defaultUnit;
      manifest.trackables.push(t);
    }
    try {
      await pb.collection("life_logs").update(log.id, { manifest });
    } catch (err) {
      lastErr = err;
      continue; // transient/conflict — re-read and retry
    }
    // Verify our appends survived a possible concurrent overwrite.
    const after = manifestOf((await pb.collection("life_logs").getOne(log.id)).manifest);
    const afterIds = new Set(after.trackables.map((t) => t.id));
    if (missing.every((s) => afterIds.has(s.id))) return; // converged
    lastErr = new Error("manifest ensure clobbered by concurrent write; retrying");
  }
  throw lastErr ?? new Error("ensureTrackables: failed to converge after retries");
}

/** Find a life_event by (log, source_id), or null. */
export async function findBySourceId(pb: PocketBase, logId: string, sourceId: string) {
  const list = await pb.collection("life_events").getList(1, 1, {
    filter: pb.filter("log = {:log} && source_id = {:sid}", { log: logId, sid: sourceId }),
  });
  return list.items[0] ?? null;
}
