/**
 * Notifications editor — the Settings surface over `manifest.notifications`
 * (the Unified Capture scheduled-nudge layer). Replaces the three legacy
 * `*_reminder_time` TimePickers. Each notification names a target View and a
 * firing `strategy` (fixed wall-clock or random sampling); this editor renders
 * a friendly row per notification and mutates the manifest via the
 * add/update/remove/reorder backend ops + `applyManifest`.
 *
 * ⚠️ PHASE D ID-SCHEME LANDMINE — see the mutate sites below. Editing an
 * existing notification ALWAYS goes through `updateNotification(logId, n.id,
 * …)`, preserving `n.id` verbatim. The id keys `reminder_state` (the
 * double-fire guard); rewriting it would break idempotency and could
 * double-fire on the seed day. We NEVER create-then-delete to "change" a
 * notification, and time edits spread the EXISTING strategy so `subsumes` /
 * `weekday` survive a time-only change. This editor relies on
 * `manifest.notifications` being the source of truth — for existing users that
 * is materialized (with the `*-reminder` ids + real column times) by the Phase
 * D3 column→manifest migration; brand-new logs may materialize
 * `DEFAULT_NOTIFICATIONS`'s bare ids on first edit, which is acceptable since
 * they have no reminder history. (Cross-ref: `DEFAULT_NOTIFICATIONS` in
 * packages/backend/src/life-view-defaults.ts and the
 * `LifeManifest.notifications` doc in packages/backend/src/types/life.ts.)
 */
import { useCallback } from "react";
import styled from "styled-components";
import { Button, Select, Switch, TimePicker, InputNumber } from "antd";
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

  const viewOptions = views.map((v) => ({ label: v.title, value: v.id }));

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
    const targetId = views[0]?.id;
    if (!targetId) {
      message.warning("Create a View first — a notification opens a View.");
      return;
    }
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
  }, [logId, views, notifications, life, run, message]);

  if (!logId) return <Empty>Loading…</Empty>;

  return (
    <div>
      {notifications.length === 0 && <Empty>No notifications. Add one to get a scheduled nudge.</Empty>}

      {notifications.map((n) => {
        const strategy = n.strategy;
        // IMMUTABLE id preserved on every patch — never create-to-edit.
        const patchStrategy = (next: LifeNotifyStrategy) =>
          run(() => life.updateNotification(logId, n.id, { strategy: next }));

        return (
          <Row key={n.id}>
            <RowHeader>
              <TargetSelect
                size="small"
                value={n.target}
                options={viewOptions}
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
