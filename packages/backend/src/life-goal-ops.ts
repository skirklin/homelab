/**
 * Canonical validation + mutation helpers for the per-user GOAL layer
 * (`life_logs.manifest.goals`). Goals are a THIN interpretive layer over
 * existing `life_events` — they add no event data and live in the manifest
 * JSON next to `trackables`. These are PURE functions over a `LifeManifest`:
 * each takes the current manifest and a request, validates it, and returns the
 * next manifest — or throws `ManifestError` with a stable `code`. They never
 * touch PocketBase.
 *
 * Same discipline as life-manifest-ops: the MCP tools and the API route layer
 * both enforce IDENTICAL rules, so there is one place that decides what a legal
 * goal mutation is. `goal.id` is IMMUTABLE (the stable join key); `scope`,
 * `kind`, and `metric` are also immutable on update — changing any of them
 * would silently redefine what the goal measures, so a new goal is the honest
 * path. Everything else (label/target/unit/period/hidden) is freely patchable.
 *
 * Mutation discipline mirrors the trackable ops: every op does a structural
 * read-modify-write that touches ONLY the targeted goal and otherwise preserves
 * the rest of the manifest byte-for-byte. Callers persist the returned manifest
 * wholesale.
 */
import type { LifeManifest, LifeGoal, LifeGoalScope } from "./types/life";
import { ManifestError, isSlug, reorderById } from "./life-manifest-ops";

export const GOAL_KINDS = ["at_least", "at_most", "frequency"] as const;
export const GOAL_METRICS = ["count", "sum", "days"] as const;
export const GOAL_PERIODS = ["day", "week"] as const;

/** Validate + normalize a scope object: exactly one of {thing}|{group}. */
function validateScope(raw: unknown): LifeGoalScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("invalid_goal", "scope must be an object {thing} or {group}");
  }
  const s = raw as Record<string, unknown>;
  const hasThing = typeof s.thing === "string" && s.thing.length > 0;
  const hasGroup = typeof s.group === "string" && s.group.length > 0;
  if (hasThing === hasGroup) {
    throw new ManifestError(
      "invalid_goal",
      "scope must be exactly one of { thing: <vocab id> } or { group: <name> }",
    );
  }
  return hasThing ? { thing: s.thing as string } : { group: s.group as string };
}

/**
 * Validate a goal definition request and return a clean `LifeGoal`. Enforces
 * the cross-field rules:
 *   - id is a slug
 *   - kind ∈ at_least|at_most|frequency, metric ∈ count|sum|days
 *   - frequency ⇒ metric MUST be "days" (it's "N days per period")
 *   - sum ⇒ `unit` REQUIRED (selects which number entry to sum)
 *   - target is a finite number > 0
 *   - period ∈ day|week
 * `unit` is dropped unless metric === "sum".
 */
function validateGoalShape(input: {
  id: string;
  label: unknown;
  scope: unknown;
  kind: unknown;
  metric: unknown;
  target: unknown;
  unit?: unknown;
  period: unknown;
  hidden?: unknown;
}): LifeGoal {
  if (!isSlug(input.id)) {
    throw new ManifestError(
      "invalid_goal",
      `goal id must be a slug (lower-kebab, [a-z0-9_-], <=64 chars); got ${JSON.stringify(input.id)}`,
    );
  }
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    throw new ManifestError("invalid_goal", "label must be a non-empty string");
  }
  const scope = validateScope(input.scope);
  if (!(GOAL_KINDS as readonly string[]).includes(input.kind as string)) {
    throw new ManifestError("invalid_goal", `kind must be one of ${GOAL_KINDS.join("|")}; got ${JSON.stringify(input.kind)}`);
  }
  const kind = input.kind as LifeGoal["kind"];
  if (!(GOAL_METRICS as readonly string[]).includes(input.metric as string)) {
    throw new ManifestError("invalid_goal", `metric must be one of ${GOAL_METRICS.join("|")}; got ${JSON.stringify(input.metric)}`);
  }
  let metric = input.metric as LifeGoal["metric"];
  if (kind === "frequency") {
    // "N days per period" — frequency only makes sense over distinct days.
    if (metric !== "days") {
      throw new ManifestError("invalid_goal", `frequency goals must use metric "days"; got ${JSON.stringify(metric)}`);
    }
    metric = "days";
  }
  if (typeof input.target !== "number" || !Number.isFinite(input.target) || input.target <= 0) {
    throw new ManifestError("invalid_goal", `target must be a finite number > 0; got ${JSON.stringify(input.target)}`);
  }
  if (!(GOAL_PERIODS as readonly string[]).includes(input.period as string)) {
    throw new ManifestError("invalid_goal", `period must be one of ${GOAL_PERIODS.join("|")}; got ${JSON.stringify(input.period)}`);
  }
  const period = input.period as LifeGoal["period"];

  const goal: LifeGoal = { id: input.id, label: input.label, scope, kind, metric, target: input.target, period };

  if (metric === "sum") {
    if (typeof input.unit !== "string" || input.unit.trim().length === 0) {
      throw new ManifestError("invalid_goal", 'metric "sum" requires a non-empty `unit` (selects which number entry to sum)');
    }
    goal.unit = input.unit;
  }
  if (input.hidden !== undefined) goal.hidden = !!input.hidden;
  return goal;
}

/** Current goals on a manifest, or [] when absent. */
export function manifestGoals(m: LifeManifest): LifeGoal[] {
  return Array.isArray(m.goals) ? m.goals : [];
}

/**
 * ADD a new goal. Validates the full shape + id uniqueness. Returns the next
 * manifest with the goal appended (manifest order = display order). Never
 * mutates `current`.
 */
export function addGoal(
  current: LifeManifest,
  input: {
    id: string;
    label: unknown;
    scope: unknown;
    kind: unknown;
    metric: unknown;
    target: unknown;
    unit?: unknown;
    period: unknown;
    hidden?: unknown;
  },
): LifeManifest {
  const goals = manifestGoals(current);
  if (goals.some((g) => g.id === input.id)) {
    throw new ManifestError("duplicate_goal", `a goal with id "${input.id}" already exists`);
  }
  const goal = validateGoalShape(input);
  return { ...current, goals: [...goals, goal] };
}

/**
 * UPDATE an existing goal. Patches only the provided keys. ENFORCES
 * immutability of `id`, `scope`, `kind`, and `metric` — changing any of them
 * would redefine what the goal measures (create a new goal instead).
 * label/target/unit/period/hidden are freely editable. Because the validated
 * shape is re-derived, a patch that (say) sets period must still satisfy every
 * cross-field rule (sum ⇒ unit, etc.).
 */
export function updateGoal(
  current: LifeManifest,
  goalId: string,
  patch: {
    id?: string;
    label?: unknown;
    scope?: unknown;
    kind?: unknown;
    metric?: unknown;
    target?: unknown;
    unit?: unknown;
    period?: unknown;
    hidden?: unknown;
  },
): LifeManifest {
  const goals = manifestGoals(current);
  const idx = goals.findIndex((g) => g.id === goalId);
  if (idx === -1) throw new ManifestError("goal_not_found", `no goal with id "${goalId}"`);
  const existing = goals[idx];

  if (patch.id !== undefined && patch.id !== goalId) {
    throw new ManifestError("immutable_goal", `goal id is immutable; cannot rename "${goalId}" → "${String(patch.id)}"`);
  }
  if (patch.scope !== undefined) {
    const nextScope = validateScope(patch.scope);
    if (JSON.stringify(nextScope) !== JSON.stringify(existing.scope)) {
      throw new ManifestError("immutable_goal", "goal scope is immutable (it defines what the goal measures); create a new goal instead");
    }
  }
  if (patch.kind !== undefined && patch.kind !== existing.kind) {
    throw new ManifestError("immutable_goal", `goal kind is immutable; cannot change "${existing.kind}" → ${JSON.stringify(patch.kind)}`);
  }
  if (patch.metric !== undefined && patch.metric !== existing.metric) {
    throw new ManifestError("immutable_goal", `goal metric is immutable; cannot change "${existing.metric}" → ${JSON.stringify(patch.metric)}`);
  }

  // Re-derive a fully-validated goal from existing + the mutable patch fields,
  // so cross-field invariants (sum ⇒ unit, frequency ⇒ days) hold post-patch.
  const merged = validateGoalShape({
    id: existing.id,
    label: patch.label !== undefined ? patch.label : existing.label,
    scope: existing.scope,
    kind: existing.kind,
    metric: existing.metric,
    target: patch.target !== undefined ? patch.target : existing.target,
    unit: patch.unit !== undefined ? patch.unit : existing.unit,
    period: patch.period !== undefined ? patch.period : existing.period,
    hidden: patch.hidden !== undefined ? patch.hidden : existing.hidden,
  });

  const next = goals.slice();
  next[idx] = merged;
  return { ...current, goals: next };
}

/** REMOVE a goal. Manifest-only; never touches life_events. Throws if absent. */
export function removeGoal(current: LifeManifest, goalId: string): LifeManifest {
  const goals = manifestGoals(current);
  if (!goals.some((g) => g.id === goalId)) {
    throw new ManifestError("goal_not_found", `no goal with id "${goalId}"`);
  }
  return { ...current, goals: goals.filter((g) => g.id !== goalId) };
}

/**
 * REORDER goals. `orderedIds` must be a permutation of the current goal ids
 * (same set, no dupes, no extras). Manifest order IS display order on the habit
 * board, so this is how the board's "reorder" edit mode persists goal order.
 * Mirrors `reorderTrackables`. Manifest-only; never touches life_events.
 */
export function reorderGoals(current: LifeManifest, orderedIds: unknown): LifeManifest {
  return { ...current, goals: reorderById(manifestGoals(current), orderedIds, "goal") };
}
