/// <reference path="../pb_data/types.d.ts" />

/**
 * notification_log — single sent-ledger for the per-day notification crons.
 *
 * WHY
 * ---
 * Five send paths used to carry five different idempotency stores, each
 * re-implementing the same Pacific day-math:
 *   - users.last_task_notification        (upkeep recurring chores)
 *   - users.last_deadline_notification    (one-shot deadline / asap)
 *   - life_logs.reminder_state            (life fixed reminders)
 *   - life_logs.sample_schedule.sentTimes (life random sampling — computed state)
 *   - users.travel_notif_state            (travel morning / evening)
 *
 * This collection replaces the pure "did I already fire this slot today?" stamps
 * with ONE append-only ledger. A row is created (idempotently, via the UNIQUE
 * index) only AFTER a push actually lands, so the mark-after-success policy and
 * the day-math live in exactly one place (services/api/src/lib/notifications/
 * ledger.ts → notifyOnce).
 *
 * SHAPE
 *   { user (relation→users), kind (text), bucket (text), sent_at (date) }
 *     kind   — the cron's logical channel, e.g. "upkeep" | "deadline" |
 *              "life_reminder:<notificationId>" | "travel_morning:<tripId>".
 *     bucket — the idempotency window key, usually todayPacific() ("YYYY-MM-DD").
 *     sent_at — when the push landed (for the prune CronJob's age filter).
 *   UNIQUE(user, kind, bucket) — a duplicate create throws, which notifyOnce
 *     treats as "already sent" (belt-and-suspenders on top of the pre-send read).
 *
 * No public access — written/read only through the api service's admin pb.
 *
 * DEPLOY-DAY NOTE
 * ---------------
 * The ledger starts EMPTY. For each daily source migrated onto it, the first
 * cron run after deploy sees no ledger row and may send ONE duplicate
 * notification that day (the retired per-user/per-log stamp that would have
 * suppressed it is no longer consulted). This is the SAME blast radius the
 * crons already tolerate (a single redundant daily nag) and self-heals after
 * the first post-deploy run writes its ledger row. No backfill is attempted.
 *
 * RETENTION: a daily `notification-log-prune` CronJob (infra/k8s/cronjobs.yaml)
 * deletes rows older than ~30 days. The ledger only needs the current window;
 * 30 days is generous forensic headroom.
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("notification_log");
      console.log("  notification_log: already exists, skipping");
      return;
    } catch {
      // create below
    }

    const usersCol = app.findCollectionByNameOrId("users");

    const col = new Collection({
      type: "base",
      name: "notification_log",
      // No public access — admin pb only.
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          type: "relation",
          name: "user",
          collectionId: usersCol.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        { type: "text", name: "kind", required: true, max: 200 },
        { type: "text", name: "bucket", required: true, max: 64 },
        { type: "date", name: "sent_at" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_notification_log_uniq ON notification_log (user, kind, bucket)",
        "CREATE INDEX idx_notification_log_sent_at ON notification_log (sent_at)",
      ],
    });

    app.save(col);
    console.log("  notification_log: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("notification_log");
      app.delete(col);
    } catch {
      // already gone
    }
  },
);
