-- =========================================================================
-- Phase 2 schema: PocketBase → Supabase translation.
--
-- Scope: tables, indexes, RLS policies, and the `supabase_realtime`
-- publication. NO data — Phase 7 handles import.
--
-- Idempotent: every CREATE uses IF NOT EXISTS; every POLICY uses
-- DROP-then-CREATE so re-running picks up policy edits.
--
-- Hard rule: PocketBase remains authoritative until cutover. Nothing here
-- is reachable from kirkl.in.
--
-- Design choices
-- --------------
-- 1. **UUID primary keys** — Supabase-native. Each table also has a
--    `legacy_pb_id text UNIQUE` column. Phase 7's data migration writes
--    PB's 15-char ID there and uses it to backfill cross-table FKs.
--
-- 2. **Junction tables for ownership** — PB stores `owners`/`subscribers`/
--    `notify_users` as comma-separated relation columns. Postgres gets
--    proper join tables (e.g. `shopping_list_owners(list_id,user_id)`).
--    Cleaner RLS, indexable, queryable.
--
-- 3. **JSONB** for everything PB stores as JSON. Same shape, queryable
--    via Postgres JSON operators if/when needed.
--
-- 4. **`auth.users` is the identity** — managed by GoTrue. A
--    `public.user_profiles` table (1:1 with auth.users) holds the
--    homelab-specific profile fields PB kept on its users row.
--
-- 5. **RLS = mirror PB rules 1:1** — same permissiveness, no tightening
--    in Phase 2. Tighten later when backend tests confirm parity.
--
-- 6. **Realtime publication scoped to user data** — admin tables
--    (oauth_*, deployments, pod_events, api_tokens, push_subscriptions)
--    are excluded for security: their CDC stream would leak secrets.
--
-- 7. **Helper functions are `SECURITY DEFINER STABLE`** so they can read
--    junction tables without triggering RLS recursion, and so the
--    planner can cache results within a statement.
-- =========================================================================

SET search_path = public, pg_catalog;

-- Extensions ---------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- uuid_generate_v4 (belt+suspenders)

-- =========================================================================
-- User profile (1:1 with auth.users)
-- =========================================================================

CREATE TABLE IF NOT EXISTS user_profiles (
    -- One row per authenticated user. CASCADE delete on auth.users removal.
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    legacy_pb_id text UNIQUE,

    name text,
    avatar_url text,

    -- Slug namespaces — small JSON objects keyed by app/category.
    shopping_slugs jsonb DEFAULT '{}'::jsonb,
    household_slugs jsonb DEFAULT '{}'::jsonb,
    travel_slugs jsonb DEFAULT '{}'::jsonb,
    recipe_boxes jsonb DEFAULT '{}'::jsonb,

    life_log_id uuid,  -- backfilled in Phase 7 to point at life_logs.id

    fcm_tokens jsonb DEFAULT '[]'::jsonb,
    upkeep_notification_mode text CHECK (upkeep_notification_mode IN ('all','subscribed','off')),
    last_task_notification timestamptz,
    cooking_mode_seen boolean DEFAULT false,
    last_seen_update_version integer,

    travel_notif_state jsonb DEFAULT '{}'::jsonb,
    timezone text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- Shopping
-- =========================================================================

CREATE TABLE IF NOT EXISTS shopping_lists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    name text NOT NULL,
    category_defs jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopping_list_owners (
    list_id uuid NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shopping_list_owners_user ON shopping_list_owners(user_id);

CREATE TABLE IF NOT EXISTS shopping_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    list_id uuid NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    ingredient text NOT NULL,
    note text,
    category_id text,
    checked boolean DEFAULT false,
    added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    checked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    checked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shopping_items_list ON shopping_items(list_id);

CREATE TABLE IF NOT EXISTS shopping_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    list_id uuid NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    ingredient text NOT NULL,
    category_id text,
    last_added timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shopping_history_list ON shopping_history(list_id);
-- Upsert target for autocomplete-history merging by normalized ingredient.
-- The Supabase backend uses `ON CONFLICT (list_id, ingredient) DO UPDATE`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopping_history_list_ingredient
    ON shopping_history(list_id, ingredient);

CREATE TABLE IF NOT EXISTS shopping_trips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    list_id uuid NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
    completed_at timestamptz NOT NULL,
    items jsonb DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shopping_trips_list ON shopping_trips(list_id);

-- =========================================================================
-- Recipes
-- =========================================================================

CREATE TABLE IF NOT EXISTS recipe_boxes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    name text NOT NULL,
    description text,
    visibility text NOT NULL CHECK (visibility IN ('private','public','unlisted')),
    creator uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    last_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipe_box_owners (
    box_id uuid NOT NULL REFERENCES recipe_boxes(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (box_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_box_owners_user ON recipe_box_owners(user_id);

CREATE TABLE IF NOT EXISTS recipe_box_subscribers (
    box_id uuid NOT NULL REFERENCES recipe_boxes(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (box_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_box_subscribers_user ON recipe_box_subscribers(user_id);

CREATE TABLE IF NOT EXISTS recipes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    box_id uuid NOT NULL REFERENCES recipe_boxes(id) ON DELETE CASCADE,
    data jsonb NOT NULL,
    visibility text NOT NULL CHECK (visibility IN ('private','public','unlisted')),
    creator uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    last_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    enrichment_status text CHECK (enrichment_status IN ('needed','pending','done','skipped')),
    pending_changes jsonb,
    step_ingredients jsonb,
    cooking_log jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recipes_box ON recipes(box_id);

CREATE TABLE IF NOT EXISTS recipe_owners (
    recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (recipe_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_owners_user ON recipe_owners(user_id);

CREATE TABLE IF NOT EXISTS recipe_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    box_id uuid NOT NULL REFERENCES recipe_boxes(id) ON DELETE CASCADE,
    subject_id text NOT NULL,
    timestamp timestamptz NOT NULL,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    data jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recipe_events_box ON recipe_events(box_id);
CREATE INDEX IF NOT EXISTS idx_recipe_events_subject ON recipe_events(subject_id);

-- =========================================================================
-- Life tracker
-- =========================================================================

CREATE TABLE IF NOT EXISTS life_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    name text NOT NULL,
    manifest jsonb DEFAULT '{}'::jsonb,
    sample_schedule jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS life_log_owners (
    log_id uuid NOT NULL REFERENCES life_logs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (log_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_life_log_owners_user ON life_log_owners(user_id);

CREATE TABLE IF NOT EXISTS life_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    log_id uuid NOT NULL REFERENCES life_logs(id) ON DELETE CASCADE,
    subject_id text NOT NULL,
    timestamp timestamptz NOT NULL,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    data jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_life_events_log ON life_events(log_id);
CREATE INDEX IF NOT EXISTS idx_life_events_subject ON life_events(subject_id);

-- =========================================================================
-- Tasks (Upkeep)
-- =========================================================================

CREATE TABLE IF NOT EXISTS task_lists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_list_owners (
    list_id uuid NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_task_list_owners_user ON task_list_owners(user_id);

CREATE TABLE IF NOT EXISTS tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    list_id uuid NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    frequency jsonb,
    last_completed timestamptz,
    snoozed_until timestamptz,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    -- Tree fields (0006_unified_tasks)
    parent_id text,          -- legacy PB id of parent; resolves via path
    path text,               -- materialized path: "<root>/<child>/<gc>"
    position numeric,
    task_type text CHECK (task_type IN ('recurring','one_shot')),
    completed boolean DEFAULT false,
    tags jsonb DEFAULT '[]'::jsonb,
    collapsed boolean DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_path ON tasks(path);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS task_notify_users (
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_task_notify_users_user ON task_notify_users(user_id);

CREATE TABLE IF NOT EXISTS task_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    list_id uuid NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
    subject_id text NOT NULL,
    timestamp timestamptz NOT NULL,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    data jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_events_list ON task_events(list_id);
CREATE INDEX IF NOT EXISTS idx_task_events_subject ON task_events(subject_id);

-- =========================================================================
-- Travel
-- =========================================================================

CREATE TABLE IF NOT EXISTS travel_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS travel_log_owners (
    log_id uuid NOT NULL REFERENCES travel_logs(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    PRIMARY KEY (log_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_travel_log_owners_user ON travel_log_owners(user_id);

CREATE TABLE IF NOT EXISTS travel_trips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    log_id uuid NOT NULL REFERENCES travel_logs(id) ON DELETE CASCADE,
    destination text NOT NULL,
    status text CHECK (status IN ('Completed','Booked','Researching','Idea','Ongoing')),
    region text,
    start_date date,
    end_date date,
    notes text,
    source_refs text,
    flagged_for_review boolean DEFAULT false,
    review_comment text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_travel_trips_log ON travel_trips(log_id);

CREATE TABLE IF NOT EXISTS travel_activities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    log_id uuid NOT NULL REFERENCES travel_logs(id) ON DELETE CASCADE,
    trip_id uuid REFERENCES travel_trips(id) ON DELETE SET NULL,
    name text NOT NULL,
    category text,
    location text,
    place_id text,
    lat double precision,
    lng double precision,
    description text,
    cost_notes text,
    duration_estimate text,
    confirmation_code text,
    details text,
    setting text CHECK (setting IN ('outdoor','indoor','either')),
    booking_reqs jsonb,
    rating double precision,
    rating_count integer,
    photo_ref text,
    flight_info jsonb,
    verdict text CHECK (verdict IN ('loved','liked','meh','skip')),
    personal_notes text,
    experienced_at timestamptz,
    distance_miles double precision,
    walk_miles double precision,
    elevation_gain_feet integer,
    difficulty text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_travel_activities_log ON travel_activities(log_id);
CREATE INDEX IF NOT EXISTS idx_travel_activities_trip ON travel_activities(trip_id);

CREATE TABLE IF NOT EXISTS travel_itineraries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    log_id uuid NOT NULL REFERENCES travel_logs(id) ON DELETE CASCADE,
    trip_id uuid NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
    name text NOT NULL,
    is_active boolean DEFAULT false,
    days jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_travel_itineraries_trip ON travel_itineraries(trip_id);

CREATE TABLE IF NOT EXISTS travel_day_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    log_id uuid NOT NULL REFERENCES travel_logs(id) ON DELETE CASCADE,
    trip_id uuid NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
    date text NOT NULL CHECK (length(date) <= 10),
    text text,
    highlight text,
    mood integer CHECK (mood IS NULL OR (mood >= 1 AND mood <= 5)),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (trip_id, date)
);
CREATE INDEX IF NOT EXISTS idx_travel_day_entries_log ON travel_day_entries(log_id);

CREATE TABLE IF NOT EXISTS trip_proposals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    trip_id uuid NOT NULL REFERENCES travel_trips(id) ON DELETE CASCADE,
    question text NOT NULL,
    reasoning text,
    candidate_ids jsonb DEFAULT '[]'::jsonb,
    claude_picks jsonb DEFAULT '[]'::jsonb,
    feedback jsonb DEFAULT '{}'::jsonb,
    overall_feedback text,
    state text NOT NULL CHECK (state IN ('open','resolved')),
    resolved_at timestamptz,
    user_responded_at timestamptz,
    claude_last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_proposals_trip ON trip_proposals(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_proposals_state ON trip_proposals(state);

-- =========================================================================
-- Sharing, push, API tokens
-- =========================================================================

CREATE TABLE IF NOT EXISTS sharing_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    code text NOT NULL UNIQUE,
    target_type text NOT NULL CHECK (target_type IN ('box','recipe','travel_log')),
    target_id uuid NOT NULL,
    created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    redeemed boolean DEFAULT false,
    redeemed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sharing_invites_created_by ON sharing_invites(created_by);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    keys jsonb NOT NULL,
    origin text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    token_prefix text,
    last_used timestamptz,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- =========================================================================
-- OAuth (admin-only)
-- =========================================================================

CREATE TABLE IF NOT EXISTS oauth_clients (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    client_id text NOT NULL UNIQUE,
    client_secret_hash text,
    client_name text NOT NULL,
    redirect_uris jsonb NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    grant_types jsonb,
    response_types jsonb,
    scope text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    code_hash text NOT NULL UNIQUE,
    client_id uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    code_challenge_method text NOT NULL,
    scope text,
    resource text,
    expires_at timestamptz NOT NULL,
    consumed boolean DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    token_hash text NOT NULL UNIQUE,
    token_prefix text,
    client_id uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    scope text,
    expires_at timestamptz NOT NULL,
    last_used timestamptz,
    family_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_user ON oauth_access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_family ON oauth_access_tokens(family_id);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    token_hash text NOT NULL UNIQUE,
    token_prefix text,
    client_id uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    scope text,
    expires_at timestamptz NOT NULL,
    revoked boolean DEFAULT false,
    family_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_user ON oauth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family ON oauth_refresh_tokens(family_id);

-- =========================================================================
-- Monitor (server-side only)
-- =========================================================================

CREATE TABLE IF NOT EXISTS deployments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    git_sha text NOT NULL,
    git_branch text,
    git_subject text,
    apps jsonb,
    duration_seconds integer,
    status text NOT NULL CHECK (status IN ('success','failure','partial')),
    deployer text,
    host text,
    notes text,
    failed_apps jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deployments_created ON deployments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

CREATE TABLE IF NOT EXISTS pod_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_pb_id text UNIQUE,
    uid text NOT NULL UNIQUE,
    namespace text,
    involved_kind text,
    involved_name text,
    type text NOT NULL CHECK (type IN ('Normal','Warning')),
    reason text,
    message text,
    source text,
    count integer,
    first_seen timestamptz,
    last_seen timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pod_events_last_seen ON pod_events(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_pod_events_type ON pod_events(type);
CREATE INDEX IF NOT EXISTS idx_pod_events_ns_obj ON pod_events(namespace, involved_name);

-- =========================================================================
-- updated_at maintenance: single trigger function reused across tables.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t text;
    -- Every table that has an updated_at column.
    tables text[] := ARRAY[
        'user_profiles','shopping_lists','shopping_items','shopping_history','shopping_trips',
        'recipe_boxes','recipes','recipe_events',
        'life_logs','life_events',
        'task_lists','tasks','task_events',
        'travel_logs','travel_trips','travel_activities','travel_itineraries',
        'travel_day_entries','trip_proposals',
        'sharing_invites','push_subscriptions','api_tokens',
        'oauth_clients','oauth_codes',
        'deployments','pod_events'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON %I', t, t);
        EXECUTE format(
            'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
            t, t
        );
    END LOOP;
END $$;

-- =========================================================================
-- Membership helpers — bypass RLS on junction tables so policies don't
-- recurse. STABLE so the planner can fold them.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.is_shopping_list_owner(p_list uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.shopping_list_owners
        WHERE list_id = p_list AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_recipe_box_owner(p_box uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.recipe_box_owners
        WHERE box_id = p_box AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_recipe_owner(p_recipe uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.recipe_owners
        WHERE recipe_id = p_recipe AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_life_log_owner(p_log uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.life_log_owners
        WHERE log_id = p_log AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_task_list_owner(p_list uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.task_list_owners
        WHERE list_id = p_list AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_travel_log_owner(p_log uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.travel_log_owners
        WHERE log_id = p_log AND user_id = auth.uid()
    );
$$;

-- =========================================================================
-- Row-Level Security
-- Enable on every table; then write per-command policies.
-- Translation invariants:
--   PB `@request.auth.id != ""`            → `auth.uid() IS NOT NULL`
--   PB `@request.auth.id ?= owners.id`     → `is_*_owner(parent.id)`
--   PB `visibility = "public"`             → `visibility = 'public'`
-- =========================================================================

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'user_profiles',
        'shopping_lists','shopping_list_owners','shopping_items','shopping_history','shopping_trips',
        'recipe_boxes','recipe_box_owners','recipe_box_subscribers','recipes','recipe_owners','recipe_events',
        'life_logs','life_log_owners','life_events',
        'task_lists','task_list_owners','tasks','task_notify_users','task_events',
        'travel_logs','travel_log_owners','travel_trips','travel_activities',
        'travel_itineraries','travel_day_entries','trip_proposals',
        'sharing_invites','push_subscriptions','api_tokens',
        'oauth_clients','oauth_codes','oauth_access_tokens','oauth_refresh_tokens',
        'deployments','pod_events'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

-- ---- user_profiles ------------------------------------------------------

DROP POLICY IF EXISTS user_profiles_self_select ON user_profiles;
CREATE POLICY user_profiles_self_select ON user_profiles FOR SELECT TO authenticated
    USING (id = auth.uid());
DROP POLICY IF EXISTS user_profiles_self_modify ON user_profiles;
CREATE POLICY user_profiles_self_modify ON user_profiles FOR UPDATE TO authenticated
    USING (id = auth.uid()) WITH CHECK (id = auth.uid());
DROP POLICY IF EXISTS user_profiles_self_insert ON user_profiles;
CREATE POLICY user_profiles_self_insert ON user_profiles FOR INSERT TO authenticated
    WITH CHECK (id = auth.uid());

-- ---- shopping ----------------------------------------------------------

DROP POLICY IF EXISTS shopping_lists_select ON shopping_lists;
CREATE POLICY shopping_lists_select ON shopping_lists FOR SELECT TO authenticated
    USING (is_shopping_list_owner(id));
DROP POLICY IF EXISTS shopping_lists_insert ON shopping_lists;
CREATE POLICY shopping_lists_insert ON shopping_lists FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS shopping_lists_update ON shopping_lists;
CREATE POLICY shopping_lists_update ON shopping_lists FOR UPDATE TO authenticated
    USING (is_shopping_list_owner(id)) WITH CHECK (is_shopping_list_owner(id));
DROP POLICY IF EXISTS shopping_lists_delete ON shopping_lists;
CREATE POLICY shopping_lists_delete ON shopping_lists FOR DELETE TO authenticated
    USING (is_shopping_list_owner(id));

DROP POLICY IF EXISTS shopping_list_owners_select ON shopping_list_owners;
CREATE POLICY shopping_list_owners_select ON shopping_list_owners FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR is_shopping_list_owner(list_id));
DROP POLICY IF EXISTS shopping_list_owners_modify ON shopping_list_owners;
CREATE POLICY shopping_list_owners_modify ON shopping_list_owners FOR ALL TO authenticated
    USING (is_shopping_list_owner(list_id)) WITH CHECK (is_shopping_list_owner(list_id));

DROP POLICY IF EXISTS shopping_items_select ON shopping_items;
CREATE POLICY shopping_items_select ON shopping_items FOR SELECT TO authenticated
    USING (is_shopping_list_owner(list_id));
DROP POLICY IF EXISTS shopping_items_insert ON shopping_items;
CREATE POLICY shopping_items_insert ON shopping_items FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS shopping_items_update ON shopping_items;
CREATE POLICY shopping_items_update ON shopping_items FOR UPDATE TO authenticated
    USING (is_shopping_list_owner(list_id)) WITH CHECK (is_shopping_list_owner(list_id));
DROP POLICY IF EXISTS shopping_items_delete ON shopping_items;
CREATE POLICY shopping_items_delete ON shopping_items FOR DELETE TO authenticated
    USING (is_shopping_list_owner(list_id));

DROP POLICY IF EXISTS shopping_history_select ON shopping_history;
CREATE POLICY shopping_history_select ON shopping_history FOR SELECT TO authenticated
    USING (is_shopping_list_owner(list_id));
DROP POLICY IF EXISTS shopping_history_insert ON shopping_history;
CREATE POLICY shopping_history_insert ON shopping_history FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS shopping_history_update ON shopping_history;
CREATE POLICY shopping_history_update ON shopping_history FOR UPDATE TO authenticated
    USING (is_shopping_list_owner(list_id)) WITH CHECK (is_shopping_list_owner(list_id));
DROP POLICY IF EXISTS shopping_history_delete ON shopping_history;
CREATE POLICY shopping_history_delete ON shopping_history FOR DELETE TO authenticated
    USING (is_shopping_list_owner(list_id));

DROP POLICY IF EXISTS shopping_trips_select ON shopping_trips;
CREATE POLICY shopping_trips_select ON shopping_trips FOR SELECT TO authenticated
    USING (is_shopping_list_owner(list_id));
DROP POLICY IF EXISTS shopping_trips_insert ON shopping_trips;
CREATE POLICY shopping_trips_insert ON shopping_trips FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS shopping_trips_update ON shopping_trips;
CREATE POLICY shopping_trips_update ON shopping_trips FOR UPDATE TO authenticated
    USING (is_shopping_list_owner(list_id)) WITH CHECK (is_shopping_list_owner(list_id));
DROP POLICY IF EXISTS shopping_trips_delete ON shopping_trips;
CREATE POLICY shopping_trips_delete ON shopping_trips FOR DELETE TO authenticated
    USING (is_shopping_list_owner(list_id));

-- ---- recipes (visibility-based read) ----------------------------------

-- recipe_boxes: list/view permissive (public + any-auth non-private + owner);
-- write owner-only.
DROP POLICY IF EXISTS recipe_boxes_select_anon ON recipe_boxes;
CREATE POLICY recipe_boxes_select_anon ON recipe_boxes FOR SELECT TO anon
    USING (visibility = 'public');
DROP POLICY IF EXISTS recipe_boxes_select_auth ON recipe_boxes;
CREATE POLICY recipe_boxes_select_auth ON recipe_boxes FOR SELECT TO authenticated
    USING (visibility = 'public' OR visibility = 'unlisted' OR is_recipe_box_owner(id));
DROP POLICY IF EXISTS recipe_boxes_insert ON recipe_boxes;
CREATE POLICY recipe_boxes_insert ON recipe_boxes FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS recipe_boxes_update ON recipe_boxes;
CREATE POLICY recipe_boxes_update ON recipe_boxes FOR UPDATE TO authenticated
    USING (is_recipe_box_owner(id)) WITH CHECK (is_recipe_box_owner(id));
DROP POLICY IF EXISTS recipe_boxes_delete ON recipe_boxes;
CREATE POLICY recipe_boxes_delete ON recipe_boxes FOR DELETE TO authenticated
    USING (is_recipe_box_owner(id));

DROP POLICY IF EXISTS recipe_box_owners_select ON recipe_box_owners;
CREATE POLICY recipe_box_owners_select ON recipe_box_owners FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR is_recipe_box_owner(box_id));
DROP POLICY IF EXISTS recipe_box_owners_modify ON recipe_box_owners;
CREATE POLICY recipe_box_owners_modify ON recipe_box_owners FOR ALL TO authenticated
    USING (is_recipe_box_owner(box_id)) WITH CHECK (is_recipe_box_owner(box_id));

DROP POLICY IF EXISTS recipe_box_subscribers_select ON recipe_box_subscribers;
CREATE POLICY recipe_box_subscribers_select ON recipe_box_subscribers FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR is_recipe_box_owner(box_id));
DROP POLICY IF EXISTS recipe_box_subscribers_modify ON recipe_box_subscribers;
CREATE POLICY recipe_box_subscribers_modify ON recipe_box_subscribers FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- recipes: visibility cascades through (recipe.visibility OR box.visibility).
-- Use an inline EXISTS lookup against recipe_boxes for the box-visibility leg.
DROP POLICY IF EXISTS recipes_select_anon ON recipes;
CREATE POLICY recipes_select_anon ON recipes FOR SELECT TO anon
    USING (
        visibility = 'public'
        OR EXISTS (SELECT 1 FROM recipe_boxes b WHERE b.id = recipes.box_id AND b.visibility = 'public')
    );
DROP POLICY IF EXISTS recipes_select_auth ON recipes;
CREATE POLICY recipes_select_auth ON recipes FOR SELECT TO authenticated
    USING (
        visibility IN ('public','unlisted')
        OR EXISTS (SELECT 1 FROM recipe_boxes b WHERE b.id = recipes.box_id AND b.visibility IN ('public','unlisted'))
        OR is_recipe_owner(id)
        OR is_recipe_box_owner(box_id)
    );
DROP POLICY IF EXISTS recipes_insert ON recipes;
CREATE POLICY recipes_insert ON recipes FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS recipes_update ON recipes;
CREATE POLICY recipes_update ON recipes FOR UPDATE TO authenticated
    USING (is_recipe_owner(id) OR is_recipe_box_owner(box_id))
    WITH CHECK (is_recipe_owner(id) OR is_recipe_box_owner(box_id));
DROP POLICY IF EXISTS recipes_delete ON recipes;
CREATE POLICY recipes_delete ON recipes FOR DELETE TO authenticated
    USING (is_recipe_owner(id) OR is_recipe_box_owner(box_id));

DROP POLICY IF EXISTS recipe_owners_select ON recipe_owners;
CREATE POLICY recipe_owners_select ON recipe_owners FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR is_recipe_owner(recipe_id));
DROP POLICY IF EXISTS recipe_owners_modify ON recipe_owners;
CREATE POLICY recipe_owners_modify ON recipe_owners FOR ALL TO authenticated
    USING (is_recipe_owner(recipe_id)) WITH CHECK (is_recipe_owner(recipe_id));

-- recipe_events: PB rule scoped through box.owners.
DROP POLICY IF EXISTS recipe_events_select ON recipe_events;
CREATE POLICY recipe_events_select ON recipe_events FOR SELECT TO authenticated
    USING (is_recipe_box_owner(box_id));
DROP POLICY IF EXISTS recipe_events_insert ON recipe_events;
CREATE POLICY recipe_events_insert ON recipe_events FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS recipe_events_update ON recipe_events;
CREATE POLICY recipe_events_update ON recipe_events FOR UPDATE TO authenticated
    USING (is_recipe_box_owner(box_id)) WITH CHECK (is_recipe_box_owner(box_id));
DROP POLICY IF EXISTS recipe_events_delete ON recipe_events;
CREATE POLICY recipe_events_delete ON recipe_events FOR DELETE TO authenticated
    USING (is_recipe_box_owner(box_id));

-- ---- life ---------------------------------------------------------------

DROP POLICY IF EXISTS life_logs_select ON life_logs;
CREATE POLICY life_logs_select ON life_logs FOR SELECT TO authenticated
    USING (is_life_log_owner(id));
DROP POLICY IF EXISTS life_logs_insert ON life_logs;
CREATE POLICY life_logs_insert ON life_logs FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS life_logs_update ON life_logs;
CREATE POLICY life_logs_update ON life_logs FOR UPDATE TO authenticated
    USING (is_life_log_owner(id)) WITH CHECK (is_life_log_owner(id));
DROP POLICY IF EXISTS life_logs_delete ON life_logs;
CREATE POLICY life_logs_delete ON life_logs FOR DELETE TO authenticated
    USING (is_life_log_owner(id));

DROP POLICY IF EXISTS life_log_owners_select ON life_log_owners;
CREATE POLICY life_log_owners_select ON life_log_owners FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR is_life_log_owner(log_id));
DROP POLICY IF EXISTS life_log_owners_modify ON life_log_owners;
CREATE POLICY life_log_owners_modify ON life_log_owners FOR ALL TO authenticated
    USING (is_life_log_owner(log_id)) WITH CHECK (is_life_log_owner(log_id));

DROP POLICY IF EXISTS life_events_select ON life_events;
CREATE POLICY life_events_select ON life_events FOR SELECT TO authenticated
    USING (is_life_log_owner(log_id));
DROP POLICY IF EXISTS life_events_insert ON life_events;
CREATE POLICY life_events_insert ON life_events FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS life_events_update ON life_events;
CREATE POLICY life_events_update ON life_events FOR UPDATE TO authenticated
    USING (is_life_log_owner(log_id)) WITH CHECK (is_life_log_owner(log_id));
DROP POLICY IF EXISTS life_events_delete ON life_events;
CREATE POLICY life_events_delete ON life_events FOR DELETE TO authenticated
    USING (is_life_log_owner(log_id));

-- ---- tasks --------------------------------------------------------------

DROP POLICY IF EXISTS task_lists_select ON task_lists;
CREATE POLICY task_lists_select ON task_lists FOR SELECT TO authenticated
    USING (is_task_list_owner(id));
DROP POLICY IF EXISTS task_lists_insert ON task_lists;
CREATE POLICY task_lists_insert ON task_lists FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS task_lists_update ON task_lists;
CREATE POLICY task_lists_update ON task_lists FOR UPDATE TO authenticated
    USING (is_task_list_owner(id)) WITH CHECK (is_task_list_owner(id));
DROP POLICY IF EXISTS task_lists_delete ON task_lists;
CREATE POLICY task_lists_delete ON task_lists FOR DELETE TO authenticated
    USING (is_task_list_owner(id));

DROP POLICY IF EXISTS task_list_owners_select ON task_list_owners;
CREATE POLICY task_list_owners_select ON task_list_owners FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR is_task_list_owner(list_id));
DROP POLICY IF EXISTS task_list_owners_modify ON task_list_owners;
CREATE POLICY task_list_owners_modify ON task_list_owners FOR ALL TO authenticated
    USING (is_task_list_owner(list_id)) WITH CHECK (is_task_list_owner(list_id));

DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT TO authenticated
    USING (is_task_list_owner(list_id));
DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE TO authenticated
    USING (is_task_list_owner(list_id)) WITH CHECK (is_task_list_owner(list_id));
DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks FOR DELETE TO authenticated
    USING (is_task_list_owner(list_id));

DROP POLICY IF EXISTS task_notify_users_select ON task_notify_users;
CREATE POLICY task_notify_users_select ON task_notify_users FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR EXISTS (
            SELECT 1 FROM tasks t WHERE t.id = task_notify_users.task_id
            AND is_task_list_owner(t.list_id)
        )
    );
DROP POLICY IF EXISTS task_notify_users_modify ON task_notify_users;
CREATE POLICY task_notify_users_modify ON task_notify_users FOR ALL TO authenticated
    USING (
        EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_notify_users.task_id AND is_task_list_owner(t.list_id))
    ) WITH CHECK (
        EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_notify_users.task_id AND is_task_list_owner(t.list_id))
    );

DROP POLICY IF EXISTS task_events_select ON task_events;
CREATE POLICY task_events_select ON task_events FOR SELECT TO authenticated
    USING (is_task_list_owner(list_id));
DROP POLICY IF EXISTS task_events_insert ON task_events;
CREATE POLICY task_events_insert ON task_events FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS task_events_update ON task_events;
CREATE POLICY task_events_update ON task_events FOR UPDATE TO authenticated
    USING (is_task_list_owner(list_id)) WITH CHECK (is_task_list_owner(list_id));
DROP POLICY IF EXISTS task_events_delete ON task_events;
CREATE POLICY task_events_delete ON task_events FOR DELETE TO authenticated
    USING (is_task_list_owner(list_id));

-- ---- travel -------------------------------------------------------------

DROP POLICY IF EXISTS travel_logs_select ON travel_logs;
CREATE POLICY travel_logs_select ON travel_logs FOR SELECT TO authenticated
    USING (is_travel_log_owner(id));
DROP POLICY IF EXISTS travel_logs_insert ON travel_logs;
CREATE POLICY travel_logs_insert ON travel_logs FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS travel_logs_update ON travel_logs;
CREATE POLICY travel_logs_update ON travel_logs FOR UPDATE TO authenticated
    USING (is_travel_log_owner(id)) WITH CHECK (is_travel_log_owner(id));
DROP POLICY IF EXISTS travel_logs_delete ON travel_logs;
CREATE POLICY travel_logs_delete ON travel_logs FOR DELETE TO authenticated
    USING (is_travel_log_owner(id));

DROP POLICY IF EXISTS travel_log_owners_select ON travel_log_owners;
CREATE POLICY travel_log_owners_select ON travel_log_owners FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_log_owners_modify ON travel_log_owners;
CREATE POLICY travel_log_owners_modify ON travel_log_owners FOR ALL TO authenticated
    USING (is_travel_log_owner(log_id)) WITH CHECK (is_travel_log_owner(log_id));

DROP POLICY IF EXISTS travel_trips_select ON travel_trips;
CREATE POLICY travel_trips_select ON travel_trips FOR SELECT TO authenticated
    USING (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_trips_insert ON travel_trips;
CREATE POLICY travel_trips_insert ON travel_trips FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS travel_trips_update ON travel_trips;
CREATE POLICY travel_trips_update ON travel_trips FOR UPDATE TO authenticated
    USING (is_travel_log_owner(log_id)) WITH CHECK (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_trips_delete ON travel_trips;
CREATE POLICY travel_trips_delete ON travel_trips FOR DELETE TO authenticated
    USING (is_travel_log_owner(log_id));

DROP POLICY IF EXISTS travel_activities_select ON travel_activities;
CREATE POLICY travel_activities_select ON travel_activities FOR SELECT TO authenticated
    USING (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_activities_insert ON travel_activities;
CREATE POLICY travel_activities_insert ON travel_activities FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS travel_activities_update ON travel_activities;
CREATE POLICY travel_activities_update ON travel_activities FOR UPDATE TO authenticated
    USING (is_travel_log_owner(log_id)) WITH CHECK (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_activities_delete ON travel_activities;
CREATE POLICY travel_activities_delete ON travel_activities FOR DELETE TO authenticated
    USING (is_travel_log_owner(log_id));

DROP POLICY IF EXISTS travel_itineraries_select ON travel_itineraries;
CREATE POLICY travel_itineraries_select ON travel_itineraries FOR SELECT TO authenticated
    USING (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_itineraries_insert ON travel_itineraries;
CREATE POLICY travel_itineraries_insert ON travel_itineraries FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS travel_itineraries_update ON travel_itineraries;
CREATE POLICY travel_itineraries_update ON travel_itineraries FOR UPDATE TO authenticated
    USING (is_travel_log_owner(log_id)) WITH CHECK (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_itineraries_delete ON travel_itineraries;
CREATE POLICY travel_itineraries_delete ON travel_itineraries FOR DELETE TO authenticated
    USING (is_travel_log_owner(log_id));

DROP POLICY IF EXISTS travel_day_entries_select ON travel_day_entries;
CREATE POLICY travel_day_entries_select ON travel_day_entries FOR SELECT TO authenticated
    USING (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_day_entries_insert ON travel_day_entries;
CREATE POLICY travel_day_entries_insert ON travel_day_entries FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS travel_day_entries_update ON travel_day_entries;
CREATE POLICY travel_day_entries_update ON travel_day_entries FOR UPDATE TO authenticated
    USING (is_travel_log_owner(log_id)) WITH CHECK (is_travel_log_owner(log_id));
DROP POLICY IF EXISTS travel_day_entries_delete ON travel_day_entries;
CREATE POLICY travel_day_entries_delete ON travel_day_entries FOR DELETE TO authenticated
    USING (is_travel_log_owner(log_id));

-- trip_proposals: PB rule goes trip→log→owners.
DROP POLICY IF EXISTS trip_proposals_select ON trip_proposals;
CREATE POLICY trip_proposals_select ON trip_proposals FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM travel_trips t
        WHERE t.id = trip_proposals.trip_id AND is_travel_log_owner(t.log_id)
    ));
DROP POLICY IF EXISTS trip_proposals_insert ON trip_proposals;
CREATE POLICY trip_proposals_insert ON trip_proposals FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS trip_proposals_update ON trip_proposals;
CREATE POLICY trip_proposals_update ON trip_proposals FOR UPDATE TO authenticated
    USING (EXISTS (
        SELECT 1 FROM travel_trips t
        WHERE t.id = trip_proposals.trip_id AND is_travel_log_owner(t.log_id)
    )) WITH CHECK (EXISTS (
        SELECT 1 FROM travel_trips t
        WHERE t.id = trip_proposals.trip_id AND is_travel_log_owner(t.log_id)
    ));
DROP POLICY IF EXISTS trip_proposals_delete ON trip_proposals;
CREATE POLICY trip_proposals_delete ON trip_proposals FOR DELETE TO authenticated
    USING (EXISTS (
        SELECT 1 FROM travel_trips t
        WHERE t.id = trip_proposals.trip_id AND is_travel_log_owner(t.log_id)
    ));

-- ---- sharing_invites: creator manages, viewable by creator or redeemer
DROP POLICY IF EXISTS sharing_invites_select ON sharing_invites;
CREATE POLICY sharing_invites_select ON sharing_invites FOR SELECT TO authenticated
    USING (created_by = auth.uid() OR redeemed_by = auth.uid());
DROP POLICY IF EXISTS sharing_invites_insert ON sharing_invites;
CREATE POLICY sharing_invites_insert ON sharing_invites FOR INSERT TO authenticated
    WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS sharing_invites_update ON sharing_invites;
CREATE POLICY sharing_invites_update ON sharing_invites FOR UPDATE TO authenticated
    USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS sharing_invites_delete ON sharing_invites;
CREATE POLICY sharing_invites_delete ON sharing_invites FOR DELETE TO authenticated
    USING (created_by = auth.uid());

-- ---- push_subscriptions: per-user
DROP POLICY IF EXISTS push_subscriptions_owner ON push_subscriptions;
CREATE POLICY push_subscriptions_owner ON push_subscriptions FOR ALL TO authenticated
    USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---- api_tokens: list/view/delete by owner; update admin-only; insert auth
DROP POLICY IF EXISTS api_tokens_select ON api_tokens;
CREATE POLICY api_tokens_select ON api_tokens FOR SELECT TO authenticated
    USING (user_id = auth.uid());
DROP POLICY IF EXISTS api_tokens_insert ON api_tokens;
CREATE POLICY api_tokens_insert ON api_tokens FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS api_tokens_delete ON api_tokens;
CREATE POLICY api_tokens_delete ON api_tokens FOR DELETE TO authenticated
    USING (user_id = auth.uid());
-- (no UPDATE policy => updates denied for authenticated)

-- ---- oauth_* (admin-only)
-- PB rules are all null/admin-only. With RLS forced + no policies for
-- anon/authenticated, only service_role (or table owner via SECURITY DEFINER
-- helper) can read/write. Intentional.

-- ---- deployments, pod_events (admin-only)
-- Same posture: no anon/authenticated policy. service_role only.

-- =========================================================================
-- Grants — service_role bypasses RLS by default; we grant DML to
-- authenticated and read-only to anon. Per-table RLS gates what they see.
-- =========================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO anon;

-- Helper functions must be callable by RLS-bound roles.
GRANT EXECUTE ON FUNCTION public.is_shopping_list_owner(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_recipe_box_owner(uuid)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_recipe_owner(uuid)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_life_log_owner(uuid)      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_list_owner(uuid)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_travel_log_owner(uuid)    TO anon, authenticated;

-- =========================================================================
-- Realtime publication: scope to user-data tables. EXPLICITLY exclude
-- secret-bearing tables (api_tokens, oauth_*, push_subscriptions) so their
-- writes don't ship through the CDC stream where a misconfigured channel
-- subscriber could see them.
-- =========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
    END IF;
END $$;

DO $$
DECLARE
    t text;
    pub_tables text[] := ARRAY[
        'user_profiles',
        'shopping_lists','shopping_list_owners','shopping_items','shopping_history','shopping_trips',
        'recipe_boxes','recipe_box_owners','recipe_box_subscribers','recipes','recipe_owners','recipe_events',
        'life_logs','life_log_owners','life_events',
        'task_lists','task_list_owners','tasks','task_notify_users','task_events',
        'travel_logs','travel_log_owners','travel_trips','travel_activities',
        'travel_itineraries','travel_day_entries','trip_proposals',
        'sharing_invites'
    ];
BEGIN
    FOREACH t IN ARRAY pub_tables LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = t
        ) THEN
            EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        END IF;
    END LOOP;
END $$;

-- REPLICA IDENTITY FULL on tables where clients commonly need the OLD row
-- in UPDATE events (e.g., to know what changed). Default is to ship only PK.
ALTER TABLE shopping_items REPLICA IDENTITY FULL;
ALTER TABLE recipes        REPLICA IDENTITY FULL;
ALTER TABLE tasks          REPLICA IDENTITY FULL;

-- Done.
