/**
 * Canonical validation + mutation helpers for the per-user VIEW and
 * NOTIFICATION layers of the Unified Capture redesign
 * (`life_logs.manifest.views` + `life_logs.manifest.notifications`). Both are
 * siblings of `trackables`/`goals` in the manifest JSON. These are PURE
 * functions over a `LifeManifest`: each takes the current manifest and a
 * request, validates it, and returns the next manifest — or throws
 * `ManifestError` with a stable `code`. They never touch PocketBase.
 *
 * Same discipline as life-goal-ops / life-manifest-ops: the MCP tools and the
 * API route layer both enforce IDENTICAL rules, so there is one place that
 * decides what a legal view/notification mutation is.
 *
 * IMMUTABILITY:
 *   - `view.id` is the runner slug written to `life_events.labels.view` (the
 *     history join key for a guided run's N correlated events). Renaming it
 *     would orphan that history, so it is immutable on update.
 *   - `notification.id` keys the `reminder_state` JSON column (the double-fire
 *     guard). Renaming it breaks idempotency, so it is immutable on update.
 *   - `notification.strategy.kind` decides HOW a notification fires (fixed
 *     wall-clock vs random sampling). Patching it would change what the
 *     notification measures (mirrors trackable.shape), so it requires
 *     remove+re-add.
 *
 * Mutation discipline mirrors the goal/trackable ops: every op does a
 * structural read-modify-write that touches ONLY the targeted view /
 * notification and otherwise preserves the rest of the manifest byte-for-byte
 * (`{ ...current, views: ... }` keeps trackables/goals/notifications intact).
 * Callers persist the returned manifest wholesale.
 */
import type {
  LifeManifest,
  LifeView,
  ViewPayload,
  LifeViewItem,
  LifeNotification,
  LifeNotifyStrategy,
  TemplateRef,
} from "./types/life";
import { ManifestError, isSlug, validateRefs, patchOptionalString, addOptionalString, reorderById } from "./life-manifest-ops";

export const VIEW_ITEM_KINDS = ["capture", "tasks_due", "banner"] as const;
export const VIEW_RENDERS = ["guided", "inline"] as const;
export const NOTIFY_KINDS = ["fixed", "random"] as const;
export const NOTIFY_CADENCES = ["daily", "weekly"] as const;

/** "HH:MM" 24h, or "" (the cron treats empty as never-deliver). */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ─────────────────────────────── Views ───────────────────────────────

/**
 * Validate ONE view item, returning a clean `LifeViewItem`. A discriminated
 * union on `kind`:
 *   - capture   → non-empty `trackableId` + optional `optional` bool. The
 *                 prompt/hint/refs live on the VOCAB row, not here.
 *   - tasks_due → no extra fields.
 *   - banner    → non-empty `text` + a valid `refs[]` (templated echo).
 */
function validateViewItem(raw: unknown, ctx: string): LifeViewItem {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("invalid_view", `${ctx} must be an object`);
  }
  const item = raw as Record<string, unknown>;
  const kind = item.kind;
  if (!(VIEW_ITEM_KINDS as readonly string[]).includes(kind as string)) {
    throw new ManifestError(
      "invalid_view",
      `${ctx}.kind must be one of ${VIEW_ITEM_KINDS.join("|")}; got ${JSON.stringify(kind)}`,
    );
  }
  if (kind === "capture") {
    if (typeof item.trackableId !== "string" || item.trackableId.length === 0) {
      throw new ManifestError("invalid_view", `${ctx}.trackableId must be a non-empty string`);
    }
    const out: LifeViewItem = { kind: "capture", trackableId: item.trackableId };
    if (item.optional !== undefined) out.optional = !!item.optional;
    return out;
  }
  if (kind === "tasks_due") {
    return { kind: "tasks_due" };
  }
  // banner
  if (typeof item.text !== "string" || item.text.length === 0) {
    throw new ManifestError("invalid_view", `${ctx}.text must be a non-empty string`);
  }
  const refs: TemplateRef[] = validateRefs(item.refs, "invalid_view") ?? [];
  return { kind: "banner", text: item.text, refs };
}

function validateViewItems(raw: unknown): LifeViewItem[] {
  if (!Array.isArray(raw)) {
    throw new ManifestError("invalid_view", "items must be an array");
  }
  return raw.map((it, i) => validateViewItem(it, `items[${i}]`));
}

/**
 * Validate a view definition request and return a clean `LifeView`. Enforces:
 *   - id is a slug
 *   - title is a non-empty string
 *   - items is a valid LifeViewItem[]
 *   - greeting/icon are optional non-empty strings
 *   - render ∈ guided|inline when present
 */
function validateViewShape(input: {
  id: string;
  title: unknown;
  greeting?: unknown;
  icon?: unknown;
  render?: unknown;
  items: unknown;
}): LifeView {
  if (!isSlug(input.id)) {
    throw new ManifestError(
      "invalid_view",
      `view id must be a slug (lower-kebab, [a-z0-9_-], <=64 chars); got ${JSON.stringify(input.id)}`,
    );
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new ManifestError("invalid_view", "title must be a non-empty string");
  }
  const items = validateViewItems(input.items);
  const view: LifeView = { id: input.id, title: input.title, items };
  addOptionalString(view, "greeting", input.greeting, "greeting", "invalid_view");
  addOptionalString(view, "icon", input.icon, "icon", "invalid_view");
  if (input.render !== undefined && input.render !== null) {
    if (!(VIEW_RENDERS as readonly string[]).includes(input.render as string)) {
      throw new ManifestError(
        "invalid_view",
        `render must be one of ${VIEW_RENDERS.join("|")}; got ${JSON.stringify(input.render)}`,
      );
    }
    view.render = input.render as LifeView["render"];
  }
  return view;
}

/** Current views on a manifest, or [] when absent. */
export function manifestViews(m: LifeManifest): LifeView[] {
  return Array.isArray(m.views) ? m.views : [];
}

/**
 * ADD a new view. Validates the full shape + id uniqueness. Returns the next
 * manifest with the view appended (manifest order = display order). Never
 * mutates `current`.
 */
export function addView(
  current: LifeManifest,
  input: {
    id: string;
    title: unknown;
    greeting?: unknown;
    icon?: unknown;
    render?: unknown;
    items: unknown;
  },
): LifeManifest {
  const views = manifestViews(current);
  if (views.some((v) => v.id === input.id)) {
    throw new ManifestError("duplicate_view", `a view with id "${input.id}" already exists`);
  }
  const view = validateViewShape(input);
  return { ...current, views: [...views, view] };
}

/**
 * UPDATE an existing view. Patches only the provided PAYLOAD keys
 * (title/greeting/icon/render/items). Immutability of `id` (the runner slug
 * written to `life_events.labels.view` — the history join key) is STRUCTURAL:
 * the patch type is the view's payload keyspace, so `id` can't even be named
 * (it's a compile error). Values stay `unknown` because raw-HTTP callers
 * (data.ts) pass untyped bodies — the op still VALIDATES each value at runtime.
 * null/"" clears the optional strings (greeting/icon) and unsets render.
 */
export function updateView(
  current: LifeManifest,
  viewId: string,
  patch: Partial<Record<keyof ViewPayload, unknown>>,
): LifeManifest {
  const views = manifestViews(current);
  const idx = views.findIndex((v) => v.id === viewId);
  if (idx === -1) throw new ManifestError("view_not_found", `no view with id "${viewId}"`);
  const existing = views[idx];

  const next: LifeView = { ...existing };

  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || patch.title.trim().length === 0) {
      throw new ManifestError("invalid_view", "title must be a non-empty string");
    }
    next.title = patch.title;
  }
  if (patch.greeting !== undefined) {
    patchOptionalString(next, "greeting", patch.greeting, "greeting", "invalid_view");
  }
  if (patch.icon !== undefined) {
    patchOptionalString(next, "icon", patch.icon, "icon", "invalid_view");
  }
  if (patch.render !== undefined) {
    if (patch.render === null) {
      delete next.render;
    } else if ((VIEW_RENDERS as readonly string[]).includes(patch.render as string)) {
      next.render = patch.render as LifeView["render"];
    } else {
      throw new ManifestError(
        "invalid_view",
        `render must be one of ${VIEW_RENDERS.join("|")}; got ${JSON.stringify(patch.render)}`,
      );
    }
  }
  if (patch.items !== undefined) {
    next.items = validateViewItems(patch.items);
  }

  const out = views.slice();
  out[idx] = next;
  return { ...current, views: out };
}

/** REMOVE a view. Manifest-only; never touches life_events. Throws if absent. */
export function removeView(current: LifeManifest, viewId: string): LifeManifest {
  const views = manifestViews(current);
  if (!views.some((v) => v.id === viewId)) {
    throw new ManifestError("view_not_found", `no view with id "${viewId}"`);
  }
  return { ...current, views: views.filter((v) => v.id !== viewId) };
}

/**
 * REORDER views. `orderedIds` must be a permutation of the current view ids
 * (same set, no dupes, no extras). Mirrors `reorderGoals`. Manifest-only.
 */
export function reorderViews(current: LifeManifest, orderedIds: unknown): LifeManifest {
  return { ...current, views: reorderById(manifestViews(current), orderedIds, "view") };
}

// ───────────────────────────── Notifications ─────────────────────────────

/**
 * Validate a notify strategy by `kind`:
 *   - fixed  → cadence ∈ daily|weekly; time a "HH:MM" 24h string (or "" =
 *              never-deliver, used by the weekly-subsume notification); optional
 *              weekday 0..6 int; optional subsumes string[].
 *   - random → timesPerDay a positive int; activeHours a [startHour,endHour]
 *              tuple of ints in 0..24.
 */
function validateStrategy(raw: unknown): LifeNotifyStrategy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("invalid_notification", "strategy must be an object");
  }
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (!(NOTIFY_KINDS as readonly string[]).includes(kind as string)) {
    throw new ManifestError(
      "invalid_notification",
      `strategy.kind must be one of ${NOTIFY_KINDS.join("|")}; got ${JSON.stringify(kind)}`,
    );
  }

  if (kind === "fixed") {
    if (!(NOTIFY_CADENCES as readonly string[]).includes(s.cadence as string)) {
      throw new ManifestError(
        "invalid_notification",
        `strategy.cadence must be one of ${NOTIFY_CADENCES.join("|")}; got ${JSON.stringify(s.cadence)}`,
      );
    }
    // "" is an allowed sentinel: the cron treats it as never-deliver (the
    // weekly-subsume notification carries no own time). Otherwise "HH:MM" 24h.
    if (typeof s.time !== "string" || (s.time !== "" && !TIME_RE.test(s.time))) {
      throw new ManifestError(
        "invalid_notification",
        `strategy.time must be a "HH:MM" 24h string or "" (never-deliver); got ${JSON.stringify(s.time)}`,
      );
    }
    const out: LifeNotifyStrategy = { kind: "fixed", cadence: s.cadence as "daily" | "weekly", time: s.time };
    if (s.weekday !== undefined) {
      if (typeof s.weekday !== "number" || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) {
        throw new ManifestError(
          "invalid_notification",
          `strategy.weekday must be an integer 0..6 (0 = Sunday); got ${JSON.stringify(s.weekday)}`,
        );
      }
      out.weekday = s.weekday;
    }
    if (s.subsumes !== undefined) {
      if (!Array.isArray(s.subsumes) || !s.subsumes.every((x) => typeof x === "string" && x.length > 0)) {
        throw new ManifestError(
          "invalid_notification",
          "strategy.subsumes must be an array of non-empty notification ids",
        );
      }
      out.subsumes = s.subsumes as string[];
    }
    return out;
  }

  // random
  if (typeof s.timesPerDay !== "number" || !Number.isInteger(s.timesPerDay) || s.timesPerDay <= 0) {
    throw new ManifestError(
      "invalid_notification",
      `strategy.timesPerDay must be a positive integer; got ${JSON.stringify(s.timesPerDay)}`,
    );
  }
  const hours = s.activeHours;
  if (
    !Array.isArray(hours) ||
    hours.length !== 2 ||
    !hours.every((h) => typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 24)
  ) {
    throw new ManifestError(
      "invalid_notification",
      `strategy.activeHours must be a [startHour, endHour] tuple of integers 0..24; got ${JSON.stringify(hours)}`,
    );
  }
  if (hours[0] >= hours[1]) {
    throw new ManifestError("invalid_notification", "activeHours start must be < end");
  }
  return {
    kind: "random",
    timesPerDay: s.timesPerDay,
    activeHours: [hours[0] as number, hours[1] as number],
  };
}

/**
 * Validate a notification definition request and return a clean
 * `LifeNotification`. Enforces:
 *   - id is a slug
 *   - target is a non-empty string (a View id)
 *   - strategy is validated by kind
 *   - enabled is an optional bool
 *   - title/body are optional non-empty strings (custom push copy)
 */
function validateNotificationShape(input: {
  id: string;
  target: unknown;
  strategy: unknown;
  enabled?: unknown;
  title?: unknown;
  body?: unknown;
}): LifeNotification {
  if (!isSlug(input.id)) {
    throw new ManifestError(
      "invalid_notification",
      `notification id must be a slug (lower-kebab, [a-z0-9_-], <=64 chars); got ${JSON.stringify(input.id)}`,
    );
  }
  if (typeof input.target !== "string" || input.target.trim().length === 0) {
    throw new ManifestError("invalid_notification", "target must be a non-empty string (a View id)");
  }
  const strategy = validateStrategy(input.strategy);
  const notif: LifeNotification = { id: input.id, target: input.target, strategy };
  if (input.enabled !== undefined) notif.enabled = !!input.enabled;
  // Optional custom push copy — non-empty strings when present (mirrors
  // greeting/icon on views). Absent/""/null → leave unset (cron derives copy).
  addOptionalString(notif, "title", input.title, "title", "invalid_notification");
  addOptionalString(notif, "body", input.body, "body", "invalid_notification");
  return notif;
}

/** Current notifications on a manifest, or [] when absent. */
export function manifestNotifications(m: LifeManifest): LifeNotification[] {
  return Array.isArray(m.notifications) ? m.notifications : [];
}

/**
 * ADD a new notification. Validates the full shape + id uniqueness. Returns the
 * next manifest with the notification appended. Never mutates `current`.
 */
export function addNotification(
  current: LifeManifest,
  input: {
    id: string;
    target: unknown;
    strategy: unknown;
    enabled?: unknown;
    title?: unknown;
    body?: unknown;
  },
): LifeManifest {
  const notifs = manifestNotifications(current);
  if (notifs.some((n) => n.id === input.id)) {
    throw new ManifestError("duplicate_notification", `a notification with id "${input.id}" already exists`);
  }
  const notif = validateNotificationShape(input);
  return { ...current, notifications: [...notifs, notif] };
}

/**
 * UPDATE an existing notification. Patches only the provided keys. ENFORCES
 * immutability of `id` (it keys `reminder_state`) and `strategy.kind` (it
 * decides how the notification fires — like trackable.shape, changing it
 * requires remove+re-add). target/enabled/title/body + the within-kind strategy
 * fields are editable; null/"" clears the optional custom-copy strings
 * (title/body).
 */
export function updateNotification(
  current: LifeManifest,
  notificationId: string,
  patch: {
    id?: string;
    target?: unknown;
    strategy?: unknown;
    enabled?: unknown;
    title?: unknown;
    body?: unknown;
  },
): LifeManifest {
  const notifs = manifestNotifications(current);
  const idx = notifs.findIndex((n) => n.id === notificationId);
  if (idx === -1) {
    throw new ManifestError("notification_not_found", `no notification with id "${notificationId}"`);
  }
  const existing = notifs[idx];

  if (patch.id !== undefined && patch.id !== notificationId) {
    throw new ManifestError(
      "immutable_notification_id",
      `notification id is immutable (it keys reminder_state); cannot rename "${notificationId}" → "${String(patch.id)}"`,
    );
  }

  const next: LifeNotification = { ...existing };

  if (patch.target !== undefined) {
    if (typeof patch.target !== "string" || patch.target.trim().length === 0) {
      throw new ManifestError("invalid_notification", "target must be a non-empty string (a View id)");
    }
    next.target = patch.target;
  }
  if (patch.strategy !== undefined) {
    const nextStrategy = validateStrategy(patch.strategy);
    if (nextStrategy.kind !== existing.strategy.kind) {
      throw new ManifestError(
        "immutable_notification_strategy_kind",
        `notification strategy.kind is immutable (it decides how the notification fires); cannot change "${existing.strategy.kind}" → "${nextStrategy.kind}" — remove + re-add instead`,
      );
    }
    next.strategy = nextStrategy;
  }
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  // Custom push copy: null/"" clears, a non-empty string sets (mirrors
  // greeting/icon on views).
  if (patch.title !== undefined) {
    patchOptionalString(next, "title", patch.title, "title", "invalid_notification");
  }
  if (patch.body !== undefined) {
    patchOptionalString(next, "body", patch.body, "body", "invalid_notification");
  }

  const out = notifs.slice();
  out[idx] = next;
  return { ...current, notifications: out };
}

/** REMOVE a notification. Manifest-only. Throws if absent. */
export function removeNotification(current: LifeManifest, notificationId: string): LifeManifest {
  const notifs = manifestNotifications(current);
  if (!notifs.some((n) => n.id === notificationId)) {
    throw new ManifestError("notification_not_found", `no notification with id "${notificationId}"`);
  }
  return { ...current, notifications: notifs.filter((n) => n.id !== notificationId) };
}

/**
 * REORDER notifications. `orderedIds` must be a permutation of the current
 * notification ids. Mirrors `reorderGoals`. Manifest-only.
 */
export function reorderNotifications(current: LifeManifest, orderedIds: unknown): LifeManifest {
  return {
    ...current,
    notifications: reorderById(manifestNotifications(current), orderedIds, "notification"),
  };
}
