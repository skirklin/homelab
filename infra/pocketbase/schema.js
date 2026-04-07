#!/usr/bin/env node
/**
 * PocketBase schema setup script.
 * Creates all collections with fields and API rules.
 *
 * Usage:
 *   PB_URL=https://api.beta.kirkl.in PB_EMAIL=admin@example.com PB_PASSWORD=xxx node schema.js
 *
 * Or via environment:
 *   export PB_URL PB_EMAIL PB_PASSWORD
 *   node infra/pocketbase/schema.js
 */

const PB_URL = process.env.PB_URL || "https://api.beta.kirkl.in";
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;

if (!PB_EMAIL || !PB_PASSWORD) {
  console.error("Set PB_EMAIL and PB_PASSWORD environment variables");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${PB_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`${method} ${path} failed:`, JSON.stringify(data, null, 2));
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return data;
}

let token = null;

async function authenticate() {
  const data = await api("POST", "/api/admins/auth-with-password", {
    identity: PB_EMAIL,
    password: PB_PASSWORD,
  });
  token = data.token;
  console.log("Authenticated as admin");
}

async function createCollection(schema) {
  try {
    const existing = await api("GET", `/api/collections/${schema.name}`);
    console.log(`  ${schema.name}: already exists, updating...`);
    await api("PATCH", `/api/collections/${schema.name}`, schema);
  } catch {
    console.log(`  ${schema.name}: creating...`);
    await api("POST", "/api/collections", schema);
  }
}

// ============================================================
// Collection definitions
// ============================================================

// Helper: common owner-based access rules
// "owners" is a relation field to users
const ownerRules = {
  listRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
  viewRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
  createRule: '@request.auth.id != ""',
  updateRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
  deleteRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
};

// Helper: child record access via parent owner check
function childRules(parentField) {
  const rule = `@request.auth.id != "" && @request.auth.id ?= ${parentField}.owners.id`;
  return {
    listRule: rule,
    viewRule: rule,
    createRule: '@request.auth.id != ""',
    updateRule: rule,
    deleteRule: rule,
  };
}

const collections = [
  // ==========================================
  // Users (extend built-in auth collection)
  // ==========================================
  // We'll update the users collection after creating others,
  // since it needs relation fields to collections that don't exist yet.

  // ==========================================
  // Groceries
  // ==========================================
  {
    name: "grocery_lists",
    type: "base",
    ...ownerRules,
    // Any authenticated user can view (for join-by-link)
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    fields: [
      { name: "name", type: "text", required: true },
      { name: "owners", type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "category_defs", type: "json", options: { maxSize: 50000 } },
    ],
  },
  {
    name: "grocery_items",
    type: "base",
    ...childRules("list"),
    fields: [
      { name: "list", type: "relation", required: true, options: { collectionId: "grocery_lists", cascadeDelete: true, maxSelect: 1 } },
      { name: "ingredient", type: "text", required: true },
      { name: "note", type: "text" },
      { name: "category_id", type: "text" },
      { name: "checked", type: "bool" },
      { name: "added_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "checked_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "checked_at", type: "date" },
    ],
  },
  {
    name: "grocery_history",
    type: "base",
    ...childRules("list"),
    fields: [
      { name: "list", type: "relation", required: true, options: { collectionId: "grocery_lists", cascadeDelete: true, maxSelect: 1 } },
      { name: "ingredient", type: "text", required: true },
      { name: "category_id", type: "text" },
      { name: "last_added", type: "date" },
    ],
  },
  {
    name: "grocery_trips",
    type: "base",
    ...childRules("list"),
    fields: [
      { name: "list", type: "relation", required: true, options: { collectionId: "grocery_lists", cascadeDelete: true, maxSelect: 1 } },
      { name: "completed_at", type: "date", required: true },
      { name: "items", type: "json", options: { maxSize: 500000 } },
    ],
  },

  // ==========================================
  // Recipes
  // ==========================================
  {
    name: "recipe_boxes",
    type: "base",
    listRule: 'visibility = "public" || (@request.auth.id != "" && @request.auth.id ?= owners.id) || (@request.auth.id != "" && visibility != "private")',
    viewRule: 'visibility = "public" || (@request.auth.id != "" && @request.auth.id ?= owners.id) || (@request.auth.id != "" && visibility != "private")',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
    deleteRule: '@request.auth.id != "" && @request.auth.id ?= owners.id',
    fields: [
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "owners", type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "subscribers", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "visibility", type: "select", required: true, options: { values: ["private", "public", "unlisted"] } },
      { name: "creator", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "last_updated_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
    ],
  },
  {
    name: "recipes",
    type: "base",
    listRule: [
      'box.visibility = "public"',
      'visibility = "public"',
      '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
      '(@request.auth.id != "" && @request.auth.id ?= box.owners.id)',
      '(@request.auth.id != "" && box.visibility != "private")',
      '(@request.auth.id != "" && visibility != "private")',
    ].join(" || "),
    viewRule: [
      'box.visibility = "public"',
      'visibility = "public"',
      '(@request.auth.id != "" && @request.auth.id ?= owners.id)',
      '(@request.auth.id != "" && @request.auth.id ?= box.owners.id)',
      '(@request.auth.id != "" && box.visibility != "private")',
      '(@request.auth.id != "" && visibility != "private")',
    ].join(" || "),
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != "" && (@request.auth.id ?= owners.id || @request.auth.id ?= box.owners.id)',
    deleteRule: '@request.auth.id != "" && (@request.auth.id ?= owners.id || @request.auth.id ?= box.owners.id)',
    fields: [
      { name: "box", type: "relation", required: true, options: { collectionId: "recipe_boxes", cascadeDelete: true, maxSelect: 1 } },
      { name: "data", type: "json", required: true, options: { maxSize: 500000 } },
      { name: "owners", type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "visibility", type: "select", required: true, options: { values: ["private", "public", "unlisted"] } },
      { name: "creator", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "last_updated_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "enrichment_status", type: "select", options: { values: ["needed", "pending", "done", "skipped"] } },
      { name: "pending_changes", type: "json", options: { maxSize: 500000 } },
      { name: "step_ingredients", type: "json", options: { maxSize: 100000 } },
      { name: "cooking_log", type: "json", options: { maxSize: 500000 } },
    ],
  },
  {
    name: "recipe_events",
    type: "base",
    ...childRules("box"),
    fields: [
      { name: "box", type: "relation", required: true, options: { collectionId: "recipe_boxes", cascadeDelete: true, maxSelect: 1 } },
      { name: "subject_id", type: "text", required: true },
      { name: "timestamp", type: "date", required: true },
      { name: "created_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "data", type: "json", options: { maxSize: 50000 } },
    ],
  },

  // ==========================================
  // Life Tracker
  // ==========================================
  {
    name: "life_logs",
    type: "base",
    ...ownerRules,
    // Any authenticated user can view (for sharing)
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    fields: [
      { name: "name", type: "text", required: true },
      { name: "owners", type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "manifest", type: "json", options: { maxSize: 200000 } },
      { name: "sample_schedule", type: "json", options: { maxSize: 50000 } },
    ],
  },
  {
    name: "life_events",
    type: "base",
    ...childRules("log"),
    fields: [
      { name: "log", type: "relation", required: true, options: { collectionId: "life_logs", cascadeDelete: true, maxSelect: 1 } },
      { name: "subject_id", type: "text", required: true },
      { name: "timestamp", type: "date", required: true },
      { name: "created_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "data", type: "json", options: { maxSize: 50000 } },
    ],
  },

  // ==========================================
  // Upkeep (Household Tasks)
  // ==========================================
  {
    name: "task_lists",
    type: "base",
    ...ownerRules,
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    fields: [
      { name: "name", type: "text", required: true },
      { name: "owners", type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "room_defs", type: "json", options: { maxSize: 50000 } },
    ],
  },
  {
    name: "tasks",
    type: "base",
    ...childRules("list"),
    fields: [
      { name: "list", type: "relation", required: true, options: { collectionId: "task_lists", cascadeDelete: true, maxSelect: 1 } },
      { name: "name", type: "text", required: true },
      { name: "description", type: "text" },
      { name: "room_id", type: "text" },
      { name: "frequency", type: "json" },
      { name: "last_completed", type: "date" },
      { name: "snoozed_until", type: "date" },
      { name: "notify_users", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "created_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
    ],
  },
  {
    name: "task_events",
    type: "base",
    ...childRules("list"),
    fields: [
      { name: "list", type: "relation", required: true, options: { collectionId: "task_lists", cascadeDelete: true, maxSelect: 1 } },
      { name: "subject_id", type: "text", required: true },
      { name: "timestamp", type: "date", required: true },
      { name: "created_by", type: "relation", options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: 1 } },
      { name: "data", type: "json", options: { maxSize: 50000 } },
    ],
  },

  // ==========================================
  // Travel
  // ==========================================
  {
    name: "travel_logs",
    type: "base",
    ...ownerRules,
    fields: [
      { name: "name", type: "text", required: true },
      { name: "owners", type: "relation", required: true, options: { collectionId: "_pb_users_auth_", cascadeDelete: false, maxSelect: null } },
      { name: "checklists", type: "json", options: { maxSize: 200000 } },
    ],
  },
  {
    name: "travel_trips",
    type: "base",
    ...childRules("log"),
    fields: [
      { name: "log", type: "relation", required: true, options: { collectionId: "travel_logs", cascadeDelete: true, maxSelect: 1 } },
      { name: "destination", type: "text", required: true },
      { name: "status", type: "select", options: { values: ["Completed", "Booked", "Researching", "Idea", "Ongoing"] } },
      { name: "region", type: "text" },
      { name: "start_date", type: "date" },
      { name: "end_date", type: "date" },
      { name: "notes", type: "text" },
      { name: "source_refs", type: "text" },
      { name: "flagged_for_review", type: "bool" },
      { name: "review_comment", type: "text" },
      { name: "checklist_done", type: "json", options: { maxSize: 50000 } },
    ],
  },
  {
    name: "travel_activities",
    type: "base",
    ...childRules("log"),
    fields: [
      { name: "log", type: "relation", required: true, options: { collectionId: "travel_logs", cascadeDelete: true, maxSelect: 1 } },
      { name: "name", type: "text", required: true },
      { name: "category", type: "text" },
      { name: "location", type: "text" },
      { name: "place_id", type: "text" },
      { name: "lat", type: "number" },
      { name: "lng", type: "number" },
      { name: "description", type: "text" },
      { name: "cost_notes", type: "text" },
      { name: "duration_estimate", type: "text" },
      { name: "confirmation_code", type: "text" },
      { name: "details", type: "text" },
      { name: "setting", type: "select", options: { values: ["outdoor", "indoor", "either"] } },
      { name: "booking_reqs", type: "json", options: { maxSize: 50000 } },
      { name: "rating", type: "number" },
      { name: "rating_count", type: "number" },
      { name: "photo_ref", type: "text" },
      { name: "trip_id", type: "relation", options: { collectionId: "travel_trips", cascadeDelete: false, maxSelect: 1 } },
    ],
  },
  {
    name: "travel_itineraries",
    type: "base",
    ...childRules("log"),
    fields: [
      { name: "log", type: "relation", required: true, options: { collectionId: "travel_logs", cascadeDelete: true, maxSelect: 1 } },
      { name: "trip_id", type: "relation", required: true, options: { collectionId: "travel_trips", cascadeDelete: true, maxSelect: 1 } },
      { name: "name", type: "text", required: true },
      { name: "is_active", type: "bool" },
      { name: "days", type: "json", required: true, options: { maxSize: 500000 } },
    ],
  },
];

// User profile fields to add to the built-in users auth collection
const userProfileFields = [
  { name: "grocery_slugs", type: "json", options: { maxSize: 10000 } },
  { name: "household_slugs", type: "json", options: { maxSize: 10000 } },
  { name: "travel_slugs", type: "json", options: { maxSize: 10000 } },
  { name: "life_log_id", type: "text" },
  { name: "fcm_tokens", type: "json", options: { maxSize: 10000 } },
  { name: "upkeep_notification_mode", type: "select", options: { values: ["all", "subscribed", "off"] } },
  { name: "last_task_notification", type: "date" },
  { name: "recipe_boxes", type: "json", options: { maxSize: 10000 } },
  { name: "cooking_mode_seen", type: "bool" },
  { name: "last_seen_update_version", type: "number" },
];

// ============================================================
// Main
// ============================================================

async function main() {
  await authenticate();

  console.log("\nCreating collections...");
  for (const col of collections) {
    await createCollection(col);
  }

  // Update users collection with profile fields
  console.log("\nAdding profile fields to users collection...");
  try {
    const users = await api("GET", "/api/collections/users");
    const existingNames = new Set(users.fields.map((f) => f.name));
    const newFields = userProfileFields.filter((f) => !existingNames.has(f.name));
    if (newFields.length > 0) {
      await api("PATCH", "/api/collections/users", {
        fields: [...users.fields, ...newFields],
      });
      console.log(`  Added ${newFields.length} profile fields to users`);
    } else {
      console.log("  All profile fields already exist");
    }
  } catch (e) {
    console.error("Failed to update users collection:", e.message);
  }

  // Enable Google OAuth
  console.log("\nNote: Enable Google OAuth provider in the PocketBase admin UI:");
  console.log(`  ${PB_URL}/_/#/settings/auth-providers`);

  console.log("\nDone! Collections created:");
  for (const col of collections) {
    console.log(`  - ${col.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
