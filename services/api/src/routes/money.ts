/**
 * Money proxy routes — forward to the ingest service's HTTP API.
 *
 * Ingest (Python, services/ingest) holds the authoritative money data in
 * sqlite and exposes a stdlib `http.server` API. These routes give the
 * existing api/MCP infrastructure (auth, OAuth, request shape) a way to
 * reach that data without each consumer needing to know about ingest.
 *
 * Read-only, with one deliberate exception: POST /accounts/:id/close
 * (see below). All other writes are deliberately not exposed — money
 * mutations are infrequent, sensitive, and not a good fit for AI
 * delegation.
 *
 * The interim story: see `services/ingest/MIGRATION.md` for the eventual
 * "move data to PocketBase" plan. This proxy is a small thing that lets
 * MCP work today without blocking on that migration.
 *
 * SECURITY — single-tenant by design (no per-user scoping). Neither
 * `forward()` nor the close endpoint reads `c.get("userId")`: every route
 * hits the same ingest sqlite for EVERY authenticated caller, including any
 * `mcpat_` OAuth user. `authMiddleware` only proves a caller is
 * authenticated, NOT authorized to this data. This is safe only because the
 * intended callers are the tailnet-only money app and the operator's own
 * tokens. Do NOT expose money to shared/invited users without first adding
 * real per-caller scoping (e.g. gate on userId, or partition ingest data).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../index";

export const moneyRoutes = new Hono<AppEnv>();

function ingestBase(): string {
  return process.env.INGEST_BASE || "http://ingest.homelab.svc.cluster.local:5555";
}

async function forward(c: Context, ingestPath: string): Promise<Response> {
  const qsIdx = c.req.url.indexOf("?");
  const qs = qsIdx >= 0 ? c.req.url.slice(qsIdx) : "";
  const url = `${ingestBase()}${ingestPath}${qs}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return c.json(
      { error: "ingest unreachable", detail: String(err) },
      502,
    );
  }
}

moneyRoutes.get("/accounts", (c) => forward(c, "/api/accounts"));
moneyRoutes.get("/accounts/:id", (c) => forward(c, `/api/accounts/${c.req.param("id")}`));
moneyRoutes.get("/balances", (c) => forward(c, "/api/balances"));
moneyRoutes.get("/transactions", (c) => forward(c, "/api/transactions"));
moneyRoutes.get("/net-worth/summary", (c) => forward(c, "/api/net-worth/summary"));
moneyRoutes.get("/net-worth/history", (c) => forward(c, "/api/net-worth/history"));
moneyRoutes.get("/performance", (c) => forward(c, "/api/performance"));
moneyRoutes.get("/spending/summary", (c) => forward(c, "/api/spending/summary"));
moneyRoutes.get("/holdings", (c) => forward(c, "/api/holdings"));
moneyRoutes.get("/allocation", (c) => forward(c, "/api/allocation"));
moneyRoutes.get("/recurring", (c) => forward(c, "/api/recurring"));
moneyRoutes.get("/institutions", (c) => forward(c, "/api/institutions"));
moneyRoutes.get("/people", (c) => forward(c, "/api/people"));
moneyRoutes.get("/last-sync", (c) => forward(c, "/api/last-sync"));

// The single deliberate write: mark an account closed (sets metadata.closed
// and inserts a $0 balance at the close date so net worth self-corrects).
// Needed for accounts that stop appearing in syncs (rollover/closure).
// Keep this the only mutation until the PB migration ships.
moneyRoutes.post("/accounts/:id/close", async (c) => {
  const url = `${ingestBase()}/api/accounts/${c.req.param("id")}/close`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await c.req.json()),
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return c.json(
      { error: "ingest unreachable", detail: String(err) },
      502,
    );
  }
});
