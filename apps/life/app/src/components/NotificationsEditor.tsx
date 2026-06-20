/**
 * Notifications editor — the Settings surface over `manifest.notifications`
 * (the Unified Capture scheduled-nudge layer). Replaces the three legacy
 * `*_reminder_time` TimePickers. Each notification names a target View and a
 * firing `strategy` (fixed wall-clock or random sampling); this editor renders
 * a friendly row per notification and mutates `manifest.notifications` in place
 * via the `add/update/remove/reorderNotification` backend ops, each wrapped in
 * the `applyManifest`→`SET_LOG` pattern.
 *
 * `manifest.notifications` is guaranteed to be a real, persisted array: EXISTING
 * logs were materialized by the column→manifest migration (carrying the
 * load-bearing `*-reminder` ids), and NEW logs are seeded from
 * `defaultLifeManifest` at creation — so this editor always operates on a
 * concrete array, never a fallback-rendered default.
 *
 * ⚠️ ID-SCHEME LANDMINE — see the mutate sites below. A notification's `id`
 * keys its `reminder_state` row (the double-fire guard), so we must NEVER
 * rewrite an existing notification's id. Every edit ALWAYS passes the existing
 * `n.id` verbatim to `updateNotification(logId, n.id, …)`; time edits spread the
 * EXISTING strategy so `subsumes` / `weekday` survive a time-only change.
 * `addNotification` mints a fresh slug ONLY for a genuinely new notification.
 * (Cross-ref: the reminder-state guard in
 * services/api/src/lib/notifications/life-notifications.ts, `DEFAULT_NOTIFICATIONS`
 * in packages/backend/src/life-view-defaults.ts, and the
 * `LifeManifest.notifications` doc in packages/backend/src/types/life.ts.)
 */
import { useCallback } from "react";
import styled from "styled-components";
import { Button, Input, Select, Switch, TimePicker, InputNumber } from "antd";
import { PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useFeedback, useLifeBackend } from "@kirkl/shared";
import {
  ManifestError,
  slugifyTrackableId,
  type LifeManifest,
  type LifeView,
  type LifeNotification,
  type LifeNotifyStrategy,
} from "@homelab/backend";

const Row = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-sm) 0;
  border-top: 1px solid var(--color-border);

  &:first-of-type {
    border-top: none;
  }
`;

const RowHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const TargetSelect = styled(Select)`
  flex: 1;
  min-width: 0;
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
`;

const FieldLabel = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

const Empty = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  padding: var(--space-xs) 0;
`;

/**
 * Reserved (non-View) notification destinations. `today` lands on the habit
 * board: `/today` redirects to `/` (the dashboard, which renders the habit
 * board inline — the standalone `<Today/>` route was removed), so a user with
 * NO Views (Angela) can still target a useful page. `viewUrl(target)` → `/today`. We
 * deliberately do NOT offer an empty-string "Dashboard" target — empty-string
 * sentinels are disallowed in this repo, and `viewUrl("")` would be "/".
 */
const RESERVED_TARGETS = [{ label: "Habit board", value: "today" }];

const WEEKDAYS = [
  { label: "Sun", value: 0 },
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
];

/** Parse "HH:MM" without the customParseFormat plugin. "" → null (never-deliver). */
function parseHHmm(s: string | undefined): Dayjs | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return dayjs().hour(parseInt(m[1], 10)).minute(parseInt(m[2], 10)).second(0).millisecond(0);
}

interface NotificationsEditorProps {
  logId: string | undefined;
  notifications: LifeNotification[];
  views: LifeView[];
  /** Persist a manifest mutation and refresh the in-memory log. */
  applyManifest: (work: () => Promise<LifeManifest>) => Promise<LifeManifest>;
}

export function NotificationsEditor({ logId, notifications, views, applyManifest }: NotificationsEditorProps) {
  const life = useLifeBackend();
  const { message } = useFeedback();

  // Target options = reserved destinations (Habit board) + the user's Views,
  // deduped by value (a View whose id collides with a reserved id keeps its
  // own label). A user with no Views (Angela) still gets the reserved options.
  const baseTargetOptions = [
    ...RESERVED_TARGETS.filter((r) => !views.some((v) => v.id === r.value)),
    ...views.map((v) => ({ label: v.title, value: v.id })),
  ];

  const run = useCallback(
    async (work: () => Promise<LifeManifest>) => {
      try {
        await applyManifest(work);
      } catch (err) {
        console.error("Notification mutation failed:", err);
        message.error(err instanceof ManifestError ? err.message : "Failed to save notification");
      }
    },
    [applyManifest, message],
  );

  const handleAdd = useCallback(() => {
    if (!logId) return;
    // Default to the first View if the user has any, else the habit board
    // (`today`) so a user with NO Views (Angela) can still add a notification.
    const targetId = views[0]?.id ?? RESERVED_TARGETS[0].value;
    // Slug id derived from the target; de-dupe with a numeric suffix so the
    // backend's uniqueness check never rejects the very first Add.
    const base = slugifyTrackableId(`${targetId}-reminder`) || "reminder";
    let id = base;
    let n = 2;
    const taken = new Set(notifications.map((x) => x.id));
    while (taken.has(id)) id = `${base}-${n++}`;
    void run(() =>
      life.addNotification(logId, {
        id,
        target: targetId,
        strategy: { kind: "fixed", cadence: "daily", time: "09:00" },
        enabled: true,
      }),
    );
  }, [logId, views, notifications, life, run]);

  if (!logId) return <Empty>Loading…</Empty>;

  return (
    <div>
      {notifications.length === 0 && <Empty>No notifications. Add one to get a scheduled nudge.</Empty>}

      {notifications.map((n) => {
        const strategy = n.strategy;
        // IMMUTABLE id preserved on every patch — never create-to-edit.
        const patchStrategy = (next: LifeNotifyStrategy) =>
          run(() => life.updateNotification(logId, n.id, { strategy: next }));

        // Never silently drop an existing target: if `n.target` isn't a known
        // option (a View was deleted, or it points at a page we don't list),
        // surface it as a selectable option so the value stays visible.
        const targetOptions = baseTargetOptions.some((o) => o.value === n.target)
          ? baseTargetOptions
          : [...baseTargetOptions, { label: n.target, value: n.target }];

        return (
          <Row key={n.id}>
            <RowHeader>
              <TargetSelect
                size="small"
                value={n.target}
                options={targetOptions}
                onChange={(v) => run(() => life.updateNotification(logId, n.id, { target: v as string }))}
                data-testid={`notif-target-${n.id}`}
              />
              <Switch
                size="small"
                checked={n.enabled !== false}
                onChange={(checked) => run(() => life.updateNotification(logId, n.id, { enabled: checked }))}
                aria-label="Enabled"
              />
              <Button
                size="small"
                danger
                type="text"
                icon={<DeleteOutlined />}
                aria-label="Remove notification"
                onClick={() => run(() => life.removeNotification(logId, n.id))}
              />
            </RowHeader>

            {strategy.kind === "fixed" ? (
              <Controls>
                <TimePicker
                  size="small"
                  format="HH:mm"
                  minuteStep={5}
                  value={parseHHmm(strategy.time)}
                  // Time-only edit: SPREAD the existing strategy so cadence /
                  // weekday / subsumes survive. Cleared → "" (never-deliver).
                  onChange={(v) => patchStrategy({ ...strategy, time: v ? v.format("HH:mm") : "" })}
                  allowClear
                  placeholder="Off"
                />
                <Select
                  size="small"
                  value={strategy.cadence}
                  style={{ width: 100 }}
                  options={[
                    { label: "Daily", value: "daily" },
                    { label: "Weekly", value: "weekly" },
                  ]}
                  // Switching to daily drops the now-meaningless weekday; switching
                  // to weekly seeds Sunday. subsumes is preserved either way.
                  onChange={(c) =>
                    patchStrategy(
                      c === "weekly"
                        ? { ...strategy, cadence: "weekly", weekday: strategy.weekday ?? 0 }
                        : { ...strategy, cadence: "daily", weekday: undefined },
                    )
                  }
                />
                {strategy.cadence === "weekly" && (
                  <Select
                    size="small"
                    value={strategy.weekday ?? 0}
                    style={{ width: 90 }}
                    options={WEEKDAYS}
                    onChange={(d) => patchStrategy({ ...strategy, weekday: d as number })}
                  />
                )}
              </Controls>
            ) : (
              <Controls>
                <FieldLabel>×/day</FieldLabel>
                <InputNumber
                  size="small"
                  min={1}
                  max={48}
                  value={strategy.timesPerDay}
                  onChange={(v) =>
                    v != null && patchStrategy({ ...strategy, timesPerDay: Math.round(v) })
                  }
                  style={{ width: 70 }}
                />
                <FieldLabel>hours</FieldLabel>
                <InputNumber
                  size="small"
                  min={0}
                  max={24}
                  value={strategy.activeHours[0]}
                  onChange={(v) =>
                    v != null &&
                    patchStrategy({ ...strategy, activeHours: [Math.round(v), strategy.activeHours[1]] })
                  }
                  style={{ width: 64 }}
                />
                <FieldLabel>–</FieldLabel>
                <InputNumber
                  size="small"
                  min={0}
                  max={24}
                  value={strategy.activeHours[1]}
                  onChange={(v) =>
                    v != null &&
                    patchStrategy({ ...strategy, activeHours: [strategy.activeHours[0], Math.round(v)] })
                  }
                  style={{ width: 64 }}
                />
              </Controls>
            )}

            {/* Optional custom push copy. Commit on blur (like the View
                title/greeting fields). Empty → null, which clears the custom
                copy so the cron falls back to the target's derived copy. */}
            <Controls>
              <Input
                size="small"
                defaultValue={n.title ?? ""}
                placeholder="Push title (optional)"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (n.title ?? "")) void run(() => life.updateNotification(logId, n.id, { title: v || null }));
                }}
                data-testid={`notif-title-${n.id}`}
              />
              <Input
                size="small"
                defaultValue={n.body ?? ""}
                placeholder="Push body (optional)"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (n.body ?? "")) void run(() => life.updateNotification(logId, n.id, { body: v || null }));
                }}
                data-testid={`notif-body-${n.id}`}
              />
            </Controls>
          </Row>
        );
      })}

      <Button
        type="dashed"
        size="small"
        icon={<PlusOutlined />}
        onClick={handleAdd}
        style={{ marginTop: "var(--space-sm)" }}
        data-testid="notif-add"
      >
        Add notification
      </Button>
    </div>
  );
}
