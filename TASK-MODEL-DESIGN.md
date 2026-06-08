# Task Data Model — Unified Nodes + Cascading Properties

**Status:** design note (not yet built). Target architecture for the task/outliner data
model. Written 2026-06-08.

This is a north star, not a migration ticket. The immediate notification fix (below) is a
deliberate down-payment on this model, not throwaway work.

---

## Motivating bug

Trip-prep TODO reminders fan out to **every owner of the task list**, regardless of who
created the task. Scott adds "Buy flight tickets" to a trip whose list he shares with
Angela; Angela gets the push too. The recipient set is computed as
`union(list.owners, task.notify_users)` in
[`services/api/src/lib/notifications/deadlines.ts`](services/api/src/lib/notifications/deadlines.ts)
— list ownership is hardcoded as "notify everyone," with no notion of *who added this task*.

That hardcoded union is one symptom of a deeper shape problem: **lists and tasks are
modeled as two different types when they are the same thing.**

---

## Current model (what exists today)

- `task_lists` — top-level container. Carries `name`, `owners` (multi-relation; the field
  PB access rules key off), formerly `room_defs`.
- `tasks` — already a forest. `0006_unified_tasks` gave every task `parent_id`, a
  materialized `path` (ancestor-id chain), and `position`. Plus `name`, `description`,
  `task_type` (recurring/one_shot), `completed`, `cleared`, `tags`, `collapsed`,
  `frequency`, `last_completed`, `snoozed_until`, `notify_users`, `created_by`, `deadline`,
  `deadline_lead_days`. Every task hangs off a `list` FK (cascade-delete + `task_events`
  scoping).

The tree already exists. The **only** thing making `task_lists` a distinct type is what it
carries that tasks don't: `owners`, `name`, and being the subscription entry point. A list
is a root node wearing a costume, and the costume is ownership.

---

## Target model

### 1. One collection of nodes

Collapse `task_lists` into the node collection. `parent_id == ""` ⇒ root. There is one
forest (equivalently: one global tree under a synthetic root, with one child per identity).
"Multiple top-level lists" is just a single tree rooted at identity.

### 2. Roots are per-viewer, not stored

A **root is computed relative to who's asking**: the shallowest node on a path where *you*
have access — a node you can see whose parent you can't. Your home screen is your
*access-roots*, not "your lists."

This is the key unlock. The same node is a deep child to one viewer and a top-level root to
another. When Scott grants Angela on an interior node (a trip's prep subtree), that node
becomes one of *Angela's* roots — she sees it top-level; in the global tree it sits levels
down under Scott's stuff. Neither stores a "list."

### 3. Cascading properties with a fixed strategy table

Each property declares a **merge strategy**, and a node's effective value is a fold over the
root→node chain. Strategies come from a fixed enum — **never arbitrary per-node JavaScript.**

| strategy | meaning | example properties |
|---|---|---|
| `local` | never inherits; node-only | `name`, `position`, `completed`, `cleared` |
| `inherit` | nearest ancestor with a value wins; self overrides (CSS cascade) | `notify_users`, `assignee`, `deadline_lead_days` |
| `union` | set-merge down the chain | `owners`, `tags` |
| `min` / `max` | numeric fold | effective lead time, priority |

Ownership and notification become *the same kind of thing* — both cascading properties,
differing only in fold strategy. The notification bug, "share a subtree," and "lists and
tasks are one type" collapse into one mechanism instead of three features.

### 4. Owners attach to any node, `union` downward

`owners` is a per-node grant that accumulates down the path. **Sharing a subtree = one grant
on one node.** No requirement that ownership live only at roots.

---

## Enforcement vs. mutation (the split that keeps the sync engine)

The tempting move — "enforce permissions in the bespoke API" — has a trap. If *enforcement*
moves to Hono, clients can no longer read PB directly, which means losing direct reads
**and** PB realtime, which means rebuilding optimistic-write + per-user-filtered realtime
(`packages/backend/src/wrapped-pb/`, `PBMirror`) as an API proxy. That's torching the layer
CLAUDE.md flags as where silent data-correctness bugs live. Don't do that unless abandoning
direct-PB is a deliberate, separate strategic bet.

Instead, **separate enforcing access from mutating access:**

- **Enforcement stays in PB as a flat rule** over a *denormalized resolved* column:
  `owners ?= @request.auth.id`. No tree-walking, no goja. Runs on every direct client
  read/write. The sync engine is untouched.
- **Mutation goes through the bespoke API.** Granting/revoking, and moving/reparenting a
  subtree (the operations that *recompute* the denormalized set) hit Hono endpoints. The API
  holds admin creds, does the cascade fold over `path` in clean TypeScript, and writes the
  resolved `owners` back over the subtree. **Clients are forbidden by PB rule from writing
  the resolved column** — only the API/admin can. Leaf edits that don't affect access
  (`name`, `completed`, `position`) stay client-direct and optimistic.

The cascade logic you don't want trapped in PB rules lives in TypeScript — you just don't
pay for it on the read path.

### This is barely a new pattern

The structural operations already round-trip a chokepoint:

- Sharing already goes through the API / `sharing.pb.js` (`create_invite`) — never a
  client-direct write.
- `move_task` is *already* a surgical server-side op because it "recomputes descendant `path`
  atomically." The owner-set recompute piggybacks on the same move/reparent path.

---

## Costs & open decisions

Decide each of these before this is real:

1. **Denormalization write-amplification.** A grant or move rewrites the resolved `owners`
   on the whole subtree (via the `path` index). Accepted trade: subtree write on rare events
   to keep reads a flat rule. Realtime composes — the denormalized write *is* the event that
   streams a newly-shared subtree into the grantee's mirror.

2. **Union can't revoke a sub-branch.** Pure `union` only widens access; you can't share a
   subtree but exclude one child without `override` semantics or explicit deny grants — and
   deny + inheritance is the classic ACL tar pit. **Recommendation: start union-only.** Add
   deny only when a real "shared the trip but not the surprise-party branch" case appears.
   Don't build deny machinery on spec.

3. **Event/cascade scoping loses the `list` FK.** `task_events` and cascade-delete currently
   key on `list`; they'd re-scope to the node's root or anywhere on `path`. Mechanical, but
   it's the migration's sharp edge.

4. **Reparent becomes API-mediated.** Open question to verify: does the outliner's
   drag-to-reparent currently write `parent_id` optimistically client-side? If so, that
   interaction becomes an API round-trip under this model. Decide whether that's acceptable,
   or whether reparent-without-grant-change can stay a client-direct fast path.

---

## Rollout

**Phase 1 — now, no schema change.** Make `notify_users` resolution a read-time cascade in
the deadline cron: walk the `parent_id`/`path` chain with the `inherit` strategy (nearest
ancestor with an explicit `notify_users` wins; a node's own value overrides). The terminal
floor, when *nothing* is set anywhere on the chain, is the task's own `created_by` — **not**
the root's `owners`. That distinction is what actually fixes the bug: if the cascade bottomed
out at "all list owners," an un-configured task would still inherit `{scott, angela}` and
Angela would keep getting pinged. With `created_by` as the floor:

- Bare tree, no notify config anywhere → each task notifies its creator (Scott's task →
  Scott). Bug fixed.
- A container with an explicit `notify_users` (a shared trip you *do* want both on) → tasks
  under it inherit that set.

For that floor to be populated, **every create path stamps `created_by` from the
authenticated identity on create** — it is *not* inherited from the parent:

- `POST /tasks` (the API path used by the MCP `add_task` / `add_trip_task` tools) stamps it
  server-side from the request's authed user.
- The frontend adapter `PocketBaseUpkeepBackend.addTask`
  ([`packages/backend/src/pocketbase/upkeep.ts`](packages/backend/src/pocketbase/upkeep.ts))
  — the path the travel app / outliner UI use to write tasks directly to PB — stamps it from
  the client's own authStore identity, never a caller-supplied value. The optimistic wpb
  create carries it too, so the overlay matches what lands server-side.

These are the only two `tasks` create sites; both now stamp `created_by`. Stamping (rather
than inheriting) is what keeps the floor non-empty: an inherited `created_by` would be
ambiguous (whose task is a child Scott added under a container Angela created?) and would
re-introduce the fan-out the cascade is trying to kill.

**Legacy gap:** tasks created *before* this change have an empty `created_by`. For those, the
cascade can't reach the creator floor and falls back to the list's `owners` (preserving the
old behavior). They'll keep doing so until they're backfilled or edited — acceptable, since
the fix is correct for all new tasks and the gap closes naturally as old one-shot prep tasks
complete and clear.

**Known limitation (intended for Phase 1):** an empty `notify_users` is treated as "inherit,"
so there is no way to silence a single leaf whose ancestor container sets an explicit
recipient list — clearing the leaf just re-inherits the ancestor's set. A PB relation can't
distinguish "unset" from "deliberately empty," so expressing "notify nobody" needs a sentinel
we're not adding now. Accepted for Phase 1; revisit if a real "mute this one task" case shows
up.

Also fix the create path so `notify_users` actually persists when a caller *does* set it
explicitly (POST `/tasks` may drop it today; only PATCH honors it). No schema change, and
the behavior is shaped toward the target model rather than against it.

**Phase 2 — later, if it earns it.** Generalize to the strategy table, collapse `task_lists`
into root nodes, add per-node `owners` grants with denormalized resolution + the
enforce-flat / mutate-via-API split. Trigger: do this when a *second* property wants to
cascade (assignee, per-subtree deadline defaults) or when subtree-sharing becomes a real
ask. One cascading property is a special case; two is a system.
