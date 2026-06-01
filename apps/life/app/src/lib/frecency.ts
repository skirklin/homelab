/**
 * Frecency over life_events history (P3 quick-entry).
 *
 * A quick-action is a replayable `QuickPayload = {entries[], labels{}}`. This
 * module ranks the DISTINCT payloads a user has logged for a trackable by
 * recency-weighted frequency, so the one-tap chips surface the values they
 * actually repeat (doses, counts, oz, categories). Pure derivation — ZERO
 * storage; pins (manual favorites) are layered on top by the caller.
 *
 * Design:
 *   - score(payload) = Σ over its occurrences of 0.5 ^ (ageDays / halfLife).
 *     A half-life of ~21 days means a log from 3 weeks ago counts half as much
 *     as one today, so habits drift with the user. Ties break on most-recent.
 *   - Distinctness key (`payloadKey`) = the measurement values (number/bool
 *     entries: name+value+unit) plus the categorical labels, normalized + sorted
 *     so order doesn't matter. TEXT entries are intentionally ignored — free-form
 *     notes are never a stable quick-action.
 *   - Discrete repeated values (5mg, 8oz, "run") cluster and surface. Continuous
 *     values (every sleep duration a different number) each score ~1 and never
 *     form a dominant chip — intended; pins cover those shortcuts.
 */
import type { LifeEvent, LifeEntry, QuickPayload, LifeManifestTrackable } from "@homelab/backend";

/** Default recency half-life. ~3 weeks: recent habits dominate, old ones fade. */
const DEFAULT_HALF_LIFE_DAYS = 21;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface FrecencyOptions {
  /** Reference "now" for the decay (defaults to current time). */
  now?: Date;
  /** Max payloads to return. */
  limit?: number;
  /** Half-life of the recency decay, in days. */
  halfLifeDays?: number;
  /** Payloads to exclude from the result (e.g. already-pinned favorites). */
  exclude?: QuickPayload[];
}

/**
 * Canonical, order-insensitive identity for a quick-action payload. Two
 * payloads with the same measurement values (number/bool entries) and category
 * labels collapse to the same key regardless of entry/label order or any text
 * entries. This is the distinctness dimension for clustering.
 */
export function payloadKey(payload: { entries: LifeEntry[]; labels?: Record<string, string> }): string {
  const entryParts: string[] = [];
  for (const e of payload.entries) {
    if (e.type === "number") entryParts.push(`${e.name}=${e.value}:${e.unit}`);
    else if (e.type === "bool") entryParts.push(`${e.name}=${e.value ? "1" : "0"}:bool`);
    // text entries are free-form — never part of the identity.
  }
  entryParts.sort();
  const labelParts = Object.entries(payload.labels ?? {})
    .map(([k, v]) => `${k}:${v}`)
    .sort();
  return `E[${entryParts.join("|")}]L[${labelParts.join("|")}]`;
}

/** Strip an event down to a replayable measurement+category payload. */
function eventToPayload(ev: LifeEvent): QuickPayload {
  const entries: LifeEntry[] = [];
  for (const e of ev.entries) {
    if (e.type === "number") {
      const out: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
      if (typeof e.scale === "number") out.scale = e.scale;
      entries.push(out);
    } else if (e.type === "bool") {
      entries.push({ name: e.name, type: "bool", value: e.value });
    }
    // text dropped — not replayable as a quick-action.
  }
  const payload: QuickPayload = { entries };
  if (ev.labels) {
    // Carry category-style labels only (skip provenance like source/tz).
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(ev.labels)) {
      if (k === "source" || k === "tz") continue;
      labels[k] = v;
    }
    if (Object.keys(labels).length > 0) payload.labels = labels;
  }
  return payload;
}

function decayWeight(ts: Date, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - ts.getTime()) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

interface Bucket {
  payload: QuickPayload;
  score: number;
  lastTs: number;
}

/**
 * Rank the distinct quick-action payloads for a single trackable by frecency.
 * Empty-payload events (no number/bool entries) are skipped — nothing to replay.
 */
export function frecentPayloads(
  events: LifeEvent[],
  trackable: LifeManifestTrackable,
  options: FrecencyOptions = {},
): QuickPayload[] {
  const now = options.now ?? new Date();
  const halfLife = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const limit = options.limit ?? 4;
  const excluded = new Set((options.exclude ?? []).map(payloadKey));

  const buckets = new Map<string, Bucket>();
  for (const ev of events) {
    if (ev.subjectId !== trackable.id) continue;
    const payload = eventToPayload(ev);
    if (payload.entries.length === 0) continue; // no replayable measurement
    const key = payloadKey(payload);
    if (excluded.has(key)) continue;
    const w = decayWeight(ev.timestamp, now, halfLife);
    const existing = buckets.get(key);
    if (existing) {
      existing.score += w;
      existing.lastTs = Math.max(existing.lastTs, ev.timestamp.getTime());
    } else {
      buckets.set(key, { payload, score: w, lastTs: ev.timestamp.getTime() });
    }
  }

  return [...buckets.values()]
    .sort((a, b) => (b.score - a.score) || (b.lastTs - a.lastTs))
    .slice(0, limit)
    .map((b) => b.payload);
}

/** One cross-trackable quick-action for the global dashboard row. */
export interface GlobalAction {
  trackable: LifeManifestTrackable;
  payload: QuickPayload;
  /** True when this came from the trackable's manual pins (not frecency). */
  pinned: boolean;
}

/**
 * Aggregate the most-frecent actions across all (non-hidden) trackables for the
 * global quick-log row. Pins come first (stable, flagged), then frecency fills
 * the remaining slots, deduped against the pins.
 */
export function globalFrecentActions(
  events: LifeEvent[],
  trackables: LifeManifestTrackable[],
  options: FrecencyOptions = {},
): GlobalAction[] {
  const now = options.now ?? new Date();
  const halfLife = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const limit = options.limit ?? 6;
  const visible = trackables.filter((t) => !t.hidden);

  // Pins first — stable, in trackable order, deduped within each trackable.
  const pinnedActions: GlobalAction[] = [];
  const seen = new Set<string>();
  for (const t of visible) {
    for (const p of t.pinned ?? []) {
      const key = `${t.id}::${payloadKey(p)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pinnedActions.push({ trackable: t, payload: p, pinned: true });
    }
  }

  // Frecency across all visible trackables, excluding each trackable's pins.
  const candidates: Array<GlobalAction & { score: number; lastTs: number }> = [];
  for (const t of visible) {
    const bucketed = new Map<string, Bucket>();
    const pinKeys = new Set((t.pinned ?? []).map(payloadKey));
    for (const ev of events) {
      if (ev.subjectId !== t.id) continue;
      const payload = eventToPayload(ev);
      if (payload.entries.length === 0) continue;
      const key = payloadKey(payload);
      if (pinKeys.has(key)) continue;
      const w = decayWeight(ev.timestamp, now, halfLife);
      const existing = bucketed.get(key);
      if (existing) {
        existing.score += w;
        existing.lastTs = Math.max(existing.lastTs, ev.timestamp.getTime());
      } else {
        bucketed.set(key, { payload, score: w, lastTs: ev.timestamp.getTime() });
      }
    }
    for (const b of bucketed.values()) {
      candidates.push({ trackable: t, payload: b.payload, pinned: false, score: b.score, lastTs: b.lastTs });
    }
  }
  candidates.sort((a, b) => (b.score - a.score) || (b.lastTs - a.lastTs));

  const out: GlobalAction[] = [...pinnedActions];
  for (const c of candidates) {
    if (out.length >= limit) break;
    out.push({ trackable: c.trackable, payload: c.payload, pinned: false });
  }
  return out.slice(0, limit);
}
