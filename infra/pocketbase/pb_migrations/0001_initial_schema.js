/// <reference path="../pb_data/types.d.ts" />

/**
 * Initial schema migration — creates all collections for the homelab apps.
 * PocketBase runs this automatically on startup via --automigrate.
 */

migrate(
  (app) => {
    const usersCol = app.findCollectionByNameOrId("users");
    const usersId = usersCol.id;

    // Helper to create or update a collection
    function ensure(name, def) {
      try {
        const existing = app.findCollectionByNameOrId(name);
        console.log(`  ${name}: already exists, skipping`);
        return existing;
      } catch {
        console.log(`  ${name}: creating`);
        const col = new Collection(def);
        app.save(col);
        return app.findCollectionByNameOrId(name);
      }
    }

    // Shorthand for relation field config
    function rel(name, collectionId, opts = {}) {
      return {
        type: "relation",
        name,
        collectionId,
        cascadeDelete: opts.cascade || false,
        maxSelect: opts.maxSelect === undefined ? null : opts.maxSelect,
        required: opts.required || false,
      };
    }

    // Owner-based child rule: authenticated + owner of parent
    function childRules(parentField) {
      const r = `@request.auth.id != "" && @request.auth.id ?= ${parentField}.owners.id`;
      return {
        listRule: r,
        viewRule: r,
        createRule: '@request.auth.id != ""',
        updateRule: r,
        deleteRule: r,
      };
    }

    // ==========================================
    // Groceries
    // ==========================================

    const groceryLists = ensure("grocery_lists", {
      type: "base",
      name: "grocery_lists",
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      deleteRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      fields: [
        { type: "text", name: "name", required: true },
        rel("owners", usersId, { required: true }),
        { type: "json", name: "category_defs", maxSize: 50000 },
      ],
    });

    ensure("grocery_items", {
      type: "base",
      name: "grocery_items",
      ...childRules("list"),
      fields: [
        rel("list", groceryLists.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "ingredient", required: true },
        { type: "text", name: "note" },
        { type: "text", name: "category_id" },
        { type: "bool", name: "checked" },
        rel("added_by", usersId, { maxSelect: 1 }),
        rel("checked_by", usersId, { maxSelect: 1 }),
        { type: "date", name: "checked_at" },
      ],
    });

    ensure("grocery_history", {
      type: "base",
      name: "grocery_history",
      ...childRules("list"),
      fields: [
        rel("list", groceryLists.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "ingredient", required: true },
        { type: "text", name: "category_id" },
        { type: "date", name: "last_added" },
      ],
    });

    ensure("grocery_trips", {
      type: "base",
      name: "grocery_trips",
      ...childRules("list"),
      fields: [
        rel("list", groceryLists.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "date", name: "completed_at", required: true },
        { type: "json", name: "items", maxSize: 500000 },
      ],
    });

    // ==========================================
    // Recipes
    // ==========================================

    const visRule = [
      'visibility = "public"',
      'box.visibility = "public"',
      '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
      '(@request.auth.id != "" && @request.auth.id ?= box.owners.id)',
      '(@request.auth.id != "" && box.visibility != "private")',
      '(@request.auth.id != "" && visibility != "private")',
    ].join(" || ");

    const boxVisRule = [
      'visibility = "public"',
      '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
      '(@request.auth.id != "" && visibility != "private")',
    ].join(" || ");

    const recipeBoxes = ensure("recipe_boxes", {
      type: "base",
      name: "recipe_boxes",
      listRule: boxVisRule,
      viewRule: boxVisRule,
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      deleteRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      fields: [
        { type: "text", name: "name", required: true },
        { type: "text", name: "description" },
        rel("owners", usersId, { required: true }),
        rel("subscribers", usersId),
        { type: "select", name: "visibility", required: true, values: ["private", "public", "unlisted"] },
        rel("creator", usersId, { maxSelect: 1 }),
        rel("last_updated_by", usersId, { maxSelect: 1 }),
      ],
    });

    ensure("recipes", {
      type: "base",
      name: "recipes",
      listRule: visRule,
      viewRule: visRule,
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && (@request.auth.id ?= owners.id || @request.auth.id ?= box.owners.id)',
      deleteRule: '@request.auth.id != "" && (@request.auth.id ?= owners.id || @request.auth.id ?= box.owners.id)',
      fields: [
        rel("box", recipeBoxes.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "json", name: "data", required: true, maxSize: 500000 },
        rel("owners", usersId, { required: true }),
        { type: "select", name: "visibility", required: true, values: ["private", "public", "unlisted"] },
        rel("creator", usersId, { maxSelect: 1 }),
        rel("last_updated_by", usersId, { maxSelect: 1 }),
        { type: "select", name: "enrichment_status", values: ["needed", "pending", "done", "skipped"] },
        { type: "json", name: "pending_changes", maxSize: 500000 },
        { type: "json", name: "step_ingredients", maxSize: 100000 },
        { type: "json", name: "cooking_log", maxSize: 500000 },
      ],
    });

    ensure("recipe_events", {
      type: "base",
      name: "recipe_events",
      ...childRules("box"),
      fields: [
        rel("box", recipeBoxes.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "subject_id", required: true },
        { type: "date", name: "timestamp", required: true },
        rel("created_by", usersId, { maxSelect: 1 }),
        { type: "json", name: "data", maxSize: 50000 },
      ],
    });

    // ==========================================
    // Life Tracker
    // ==========================================

    const lifeLogs = ensure("life_logs", {
      type: "base",
      name: "life_logs",
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      deleteRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      fields: [
        { type: "text", name: "name", required: true },
        rel("owners", usersId, { required: true }),
        { type: "json", name: "manifest", maxSize: 200000 },
        { type: "json", name: "sample_schedule", maxSize: 50000 },
      ],
    });

    ensure("life_events", {
      type: "base",
      name: "life_events",
      ...childRules("log"),
      fields: [
        rel("log", lifeLogs.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "subject_id", required: true },
        { type: "date", name: "timestamp", required: true },
        rel("created_by", usersId, { maxSelect: 1 }),
        { type: "json", name: "data", maxSize: 50000 },
      ],
    });

    // ==========================================
    // Upkeep (Household Tasks)
    // ==========================================

    const taskLists = ensure("task_lists", {
      type: "base",
      name: "task_lists",
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: '@request.auth.id != ""',
      updateRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      deleteRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
      fields: [
        { type: "text", name: "name", required: true },
        rel("owners", usersId, { required: true }),
        { type: "json", name: "room_defs", maxSize: 50000 },
      ],
    });

    ensure("tasks", {
      type: "base",
      name: "tasks",
      ...childRules("list"),
      fields: [
        rel("list", taskLists.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "name", required: true },
        { type: "text", name: "description" },
        { type: "text", name: "room_id" },
        { type: "json", name: "frequency" },
        { type: "date", name: "last_completed" },
        { type: "date", name: "snoozed_until" },
        rel("notify_users", usersId),
        rel("created_by", usersId, { maxSelect: 1 }),
      ],
    });

    ensure("task_events", {
      type: "base",
      name: "task_events",
      ...childRules("list"),
      fields: [
        rel("list", taskLists.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "subject_id", required: true },
        { type: "date", name: "timestamp", required: true },
        rel("created_by", usersId, { maxSelect: 1 }),
        { type: "json", name: "data", maxSize: 50000 },
      ],
    });

    // ==========================================
    // Travel
    // ==========================================

    const ownerRule = '@request.auth.id != "" && @request.auth.id ?= owners.id';
    const travelLogs = ensure("travel_logs", {
      type: "base",
      name: "travel_logs",
      listRule: ownerRule,
      viewRule: ownerRule,
      createRule: '@request.auth.id != ""',
      updateRule: ownerRule,
      deleteRule: ownerRule,
      fields: [
        { type: "text", name: "name", required: true },
        rel("owners", usersId, { required: true }),
        { type: "json", name: "checklists", maxSize: 200000 },
      ],
    });

    const travelTrips = ensure("travel_trips", {
      type: "base",
      name: "travel_trips",
      ...childRules("log"),
      fields: [
        rel("log", travelLogs.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "destination", required: true },
        { type: "select", name: "status", values: ["Completed", "Booked", "Researching", "Idea", "Ongoing"] },
        { type: "text", name: "region" },
        { type: "date", name: "start_date" },
        { type: "date", name: "end_date" },
        { type: "text", name: "notes" },
        { type: "text", name: "source_refs" },
        { type: "bool", name: "flagged_for_review" },
        { type: "text", name: "review_comment" },
        { type: "json", name: "checklist_done", maxSize: 50000 },
      ],
    });

    ensure("travel_activities", {
      type: "base",
      name: "travel_activities",
      ...childRules("log"),
      fields: [
        rel("log", travelLogs.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "name", required: true },
        { type: "text", name: "category" },
        { type: "text", name: "location" },
        { type: "text", name: "place_id" },
        { type: "number", name: "lat" },
        { type: "number", name: "lng" },
        { type: "text", name: "description" },
        { type: "text", name: "cost_notes" },
        { type: "text", name: "duration_estimate" },
        { type: "text", name: "confirmation_code" },
        { type: "text", name: "details" },
        { type: "select", name: "setting", values: ["outdoor", "indoor", "either"] },
        { type: "json", name: "booking_reqs", maxSize: 50000 },
        { type: "number", name: "rating" },
        { type: "number", name: "rating_count" },
        { type: "text", name: "photo_ref" },
        rel("trip_id", travelTrips.id, { maxSelect: 1 }),
      ],
    });

    ensure("travel_itineraries", {
      type: "base",
      name: "travel_itineraries",
      ...childRules("log"),
      fields: [
        rel("log", travelLogs.id, { required: true, cascade: true, maxSelect: 1 }),
        rel("trip_id", travelTrips.id, { required: true, cascade: true, maxSelect: 1 }),
        { type: "text", name: "name", required: true },
        { type: "bool", name: "is_active" },
        { type: "json", name: "days", required: true, maxSize: 500000 },
      ],
    });

    // ==========================================
    // User profile fields
    // ==========================================

    console.log("  users: adding profile fields");
    const profileFields = [
      new Field({ type: "json", name: "grocery_slugs", maxSize: 10000 }),
      new Field({ type: "json", name: "household_slugs", maxSize: 10000 }),
      new Field({ type: "json", name: "travel_slugs", maxSize: 10000 }),
      new Field({ type: "text", name: "life_log_id" }),
      new Field({ type: "json", name: "fcm_tokens", maxSize: 10000 }),
      new Field({ type: "select", name: "upkeep_notification_mode", values: ["all", "subscribed", "off"] }),
      new Field({ type: "date", name: "last_task_notification" }),
      new Field({ type: "json", name: "recipe_boxes", maxSize: 10000 }),
      new Field({ type: "bool", name: "cooking_mode_seen" }),
      new Field({ type: "number", name: "last_seen_update_version" }),
    ];
    for (const f of profileFields) {
      usersCol.fields.add(f);
    }
    app.save(usersCol);

    console.log("Schema migration complete!");
  },
  (app) => {
    const names = [
      "travel_itineraries", "travel_activities", "travel_trips", "travel_logs",
      "task_events", "tasks", "task_lists",
      "life_events", "life_logs",
      "recipe_events", "recipes", "recipe_boxes",
      "grocery_trips", "grocery_history", "grocery_items", "grocery_lists",
    ];
    for (const name of names) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch { /* already gone */ }
    }
  }
);
