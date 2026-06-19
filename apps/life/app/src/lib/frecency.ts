/**
 * Frecency over life_events history (quick-entry chips).
 *
 * A quick-action is a replayable `(subjectId, QuickPayload)` pair. This module
 * ranks the DISTINCT payloads a user has logged by recency-weighted frequency,
 * so the one-tap chips surface the values they actually repeat (doses, counts,
 * oz). Pure derivation — ZERO storage; pins (manual favorites) are layered on
 * top by the caller.
 *
 * Design:
 *   - score(action) = Σ over its occurrences of 0.5 ^ (ageDays / halfLife).
 *     A half-life of ~21 days means a log from 3 weeks ago counts half as much
 *     as one today, so habits drift with the user. Ties break on most-recent.
 *   - Distinctness key (`payloadKey`) = the SUBJECT plus the measurement
 *     values (number entries: value+unit — NOT the entry name, mirroring the
 *     name-agnostic readers over historical names dose/volume/drinks/...)
 *     plus the categorical labels, normalized + sorted so order doesn't
 *     matter. TEXT entries are intentionally excluded from keys AND from
 *     replay — free-form notes are never a stable quick-action.
 *   - Discrete repeated values (5mg, 8oz) cluster and surface. Continuous
 *     values (every sleep duration a different number) each score ~1 and never
 *     form a dominant chip — intended; pins cover those shortcuts.
 */
import type { LifeEvent, LifeEntry, QuickPayload, LifeManifestTrackable } from "@homelab/backend";
import { isInputEligible } from "./shapes";

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
 * Canonical, order-insensitive identity for a quick-action. Keyed on the
 * SUBJECT (which thing the replay targets) plus the measurement values
 * (number/bool entries as value:unit — the entry NAME is deliberately
 * excluded, matching the name-agnostic readers: a pre-migration pin
 * `dose=5:mg` and a canonical-name event `amount=5:mg` are the SAME
 * quick-action) and category labels; text entries never participate.
 */
export function payloadKey(
  subjectId: string,
  payload: { entries: LifeEntry[]; labels?: Record<string, string> },
): string {
  const entryParts: string[] = [];
  for (const e of payload.entries) {
    if (e.type === "number") entryParts.push(`${e.value}:${e.unit}`);
    else if (e.type === "bool") entryParts.push(`${e.value ? "1" : "0"}:bool`);
    // text entries are free-form — never part of the identity.
  }
  entryParts.sort();
  const labelParts = Object.entries(payload.labels ?? {})
    .map(([k, v]) => `${k}:${v}`)
    .sort();
  return `${subjectId}::E[${entryParts.join("|")}]L[${labelParts.join("|")}]`;
}

/**
 * Strip an event down to a replayable measurement payload. Text entries are
 * dropped (excluded from replay — a replayed note would duplicate free-form
 * prose); provenance labels (source/tz) are dropped too.
 */
export function eventToPayload(ev: LifeEvent): QuickPayload {
  const entries: LifeEntry[] = [];
  for (const e of ev.entries) {
    if (e.type === "number") {
      const out: LifeEntry = { name: e.name, type: "number", value: e.value, unit: e.unit };
      if (typeof e.scale === "number") out.scale = e.scale;
      entries.push(out);
    } else if (e.type === "bool") {
      entries.push({ name: e.name, type: "bool", value: e.value });
    }
  }
  const payload: QuickPayload = { entries };
  if (ev.labels) {
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

function bucketize(
  events: LifeEvent[],
  subjectId: string,
  now: Date,
  halfLife: number,
  excludedKeys: Set<string>,
): Map<string, Bucket> {
  const buckets = new Map<string, Bucket>();
  for (const ev of events) {
    if (ev.subjectId !== subjectId) continue;
    const payload = eventToPayload(ev);
    if (payload.entries.length === 0) continue; // no replayable measurement
    const key = payloadKey(subjectId, payload);
    if (excludedKeys.has(key)) continue;
    const w = decayWeight(ev.timestamp, now, halfLife);
    const existing = buckets.get(key);
    if (existing) {
      existing.score += w;
      existing.lastTs = Math.max(existing.lastTs, ev.timestamp.getTime());
    } else {
      buckets.set(key, { payload, score: w, lastTs: ev.timestamp.getTime() });
    }
  }
  return buckets;
}

/**
 * Rank the distinct quick-action payloads for ONE thing by frecency.
 * Empty-payload events (no number/bool entries) are skipped — nothing to replay.
 */
export function frecentPayloads(
  events: LifeEvent[],
  subjectId: string,
  options: FrecencyOptions = {},
): QuickPayload[] {
  const now = options.now ?? new Date();
  const halfLife = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const limit = options.limit ?? 4;
  const excluded = new Set((options.exclude ?? []).map((p) => payloadKey(subjectId, p)));

  return [...bucketize(events, subjectId, now, halfLife, excluded).values()]
    .sort((a, b) => (b.score - a.score) || (b.lastTs - a.lastTs))
    .slice(0, limit)
    .map((b) => b.payload);
}

/** One cross-thing quick-action for the global dashboard row. */
export interface GlobalAction {
  trackable: LifeManifestTrackable;
  payload: QuickPayload;
  /** True when this came from the trackable's manual pins (not frecency). */
  pinned: boolean;
}

/**
 * The Favorites quick row: ONLY the user's explicit pins, in vocab order
 * (never trimmed, deduped within each trackable). NO frecency fill — favorites
 * are a deliberately curated row, so a thing only appears once the user stars a
 * value for it (the ShapeSheet star). Reflective (`noted`) vocab is excluded via
 * `isInputEligible` — replaying a free-text note is meaningless (one site of the
 * EXCLUSION INVARIANT).
 */
export function pinnedActions(
  trackables: LifeManifestTrackable[],
): GlobalAction[] {
  const out: GlobalAction[] = [];
  const seen = new Set<string>();
  for (const t of trackables.filter(isInputEligible)) {
    for (const p of t.pinned ?? []) {
      const key = payloadKey(t.id, p);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ trackable: t, payload: p, pinned: true });
    }
  }
  return out;
}

