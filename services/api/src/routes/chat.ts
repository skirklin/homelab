/**
 * Chat route — PM ↔ user chat channel (Phase C, see
 * apps/life/OBSERVER_BUILD_PLAN.md §"Phase C — PM ↔ user channel").
 *
 * Renamed from `coach` before any deploy; the user-facing name is "Chat".
 *
 * Backs the MCP tools (`list_chat_messages`, `post_chat_message`,
 * `resolve_chat_message`) so the daily PM cron and future Claude Code SDK
 * responder have a stable surface. The frontend `/chat` UI talks to PB
 * directly via the backend abstraction (no REST roundtrip there).
 *
 * All three endpoints are owner-scoped:
 *   - `userId` comes from auth context (set by authMiddleware).
 *   - Reads filter by `owner = userId`.
 *   - `post` stamps `owner = userId` regardless of payload.
 *   - `resolve` verifies ownership via `userOwnsChatMessage` before
 *     mutating; admin-PB callers (`hlk_`/`mcpat_` tokens) bypass PB
 *     collection rules so this gate is the only ownership check.
 *
 * Surface kept minimal: no list, no delete, no edit-body — those aren't
 * needed yet; bake them in when a real caller materializes.
 */
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { handler } from "../lib/handler";
import { userOwnsChatMessage } from "../lib/authz";

export const chatRoutes = new Hono<AppEnv>();

const VALID_ROLES = ["assistant", "user"] as const;
type Role = (typeof VALID_ROLES)[number];

const VALID_KINDS = [
  "chat",
  "question",
  "deploy_request",
  "feedback",
  "note",
] as const;
type Kind = (typeof VALID_KINDS)[number];

/**
 * Parse a `since` query param to an ISO datetime; returns null when absent.
 * Throws (caught by handler) on a malformed value.
 */
function parseSince(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid since: must be a valid ISO datetime`);
  }
  return d.toISOString();
}

// GET /chat/messages?since=…&limit=…&resolved=true|false
chatRoutes.get("/messages", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const url = new URL(c.req.url);
  let sinceIso: string | null;
  try {
    sinceIso = parseSince(url.searchParams.get("since") ?? undefined);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 50)) : 50;
  const resolvedRaw = url.searchParams.get("resolved");
  const resolved =
    resolvedRaw === "true" ? true : resolvedRaw === "false" ? false : undefined;

  const clauses = ["owner = {:uid}"];
  const params: Record<string, unknown> = { uid: userId };
  if (sinceIso) {
    clauses.push("created > {:since}");
    params.since = sinceIso;
  }
  if (typeof resolved === "boolean") {
    clauses.push("resolved = {:resolved}");
    params.resolved = resolved;
  }
  const filter = pb.filter(clauses.join(" && "), params);

  const result = await pb.collection("chat_messages").getList(1, limit, {
    filter,
    sort: "-created",
  });
  return c.json({ items: result.items });
}));

// POST /chat/messages — body: { role, body, kind?, meta? }
chatRoutes.post("/messages", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json<{
    role?: string;
    body?: string;
    kind?: string;
    meta?: unknown;
  }>();

  if (!body.role || !VALID_ROLES.includes(body.role as Role)) {
    return c.json(
      { error: `Invalid role: must be one of ${VALID_ROLES.join(", ")}` },
      400,
    );
  }
  if (typeof body.body !== "string" || body.body.length === 0) {
    return c.json({ error: "body is required" }, 400);
  }
  if (body.body.length > 20000) {
    return c.json({ error: "body exceeds 20000 characters" }, 400);
  }
  const kind: Kind = (body.kind as Kind | undefined) ?? "chat";
  if (!VALID_KINDS.includes(kind)) {
    return c.json(
      { error: `Invalid kind: must be one of ${VALID_KINDS.join(", ")}` },
      400,
    );
  }

  const payload: Record<string, unknown> = {
    owner: userId,
    role: body.role,
    body: body.body,
    kind,
    resolved: false,
  };
  if (body.meta !== undefined && body.meta !== null) {
    payload.meta = body.meta;
  }
  const record = await pb.collection("chat_messages").create(payload);
  return c.json(record);
}));

// POST /chat/messages/:id/resolve
chatRoutes.post("/messages/:id/resolve", handler(async (c) => {
  const pb = c.get("pb");
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Not authenticated" }, 401);

  const id = c.req.param("id") ?? "";
  if (!id) return c.json({ error: "missing id" }, 400);

  // admin-PB bypasses PB collection rules; the only ownership gate for
  // hlk_/mcpat_ callers is this helper. Mirror's PB rule string is
  // checked by the authz-mirror property test.
  if (!(await userOwnsChatMessage(pb, id, userId))) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const record = await pb.collection("chat_messages").update(id, { resolved: true });
  return c.json(record);
}));
