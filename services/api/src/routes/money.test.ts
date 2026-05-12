/**
 * Unit tests for the money proxy router.
 *
 * Mounts the router on a bare Hono app (no auth middleware) and stubs
 * global `fetch` to simulate ingest's responses. Verifies the proxy
 * forwards method, query string, status, and body faithfully, and that
 * a network failure returns 502 instead of bubbling the TypeError.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { moneyRoutes } from "./money";

describe("money proxy routes", () => {
  let app: Hono;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.INGEST_BASE = "http://test-ingest:5555";
    app = new Hono();
    app.route("/money", moneyRoutes);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INGEST_BASE;
  });

  function mockIngest(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
  }

  it("GET /money/accounts proxies to /api/accounts", async () => {
    mockIngest(200, { accounts: [{ id: "a1", name: "Checking" }] });
    const res = await app.request("/money/accounts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://test-ingest:5555/api/accounts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [{ id: "a1", name: "Checking" }] });
  });

  it("GET /money/balances forwards query string verbatim", async () => {
    mockIngest(200, { balances: [] });
    await app.request("/money/balances?account_id=acct_x");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test-ingest:5555/api/balances?account_id=acct_x",
    );
  });

  it("GET /money/transactions forwards multi-param query", async () => {
    mockIngest(200, { transactions: [] });
    await app.request("/money/transactions?start=2026-01-01&end=2026-01-31&limit=50");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith("http://test-ingest:5555/api/transactions?")).toBe(true);
    expect(url).toContain("start=2026-01-01");
    expect(url).toContain("end=2026-01-31");
    expect(url).toContain("limit=50");
  });

  it("GET /money/net-worth/summary maps to /api/net-worth/summary", async () => {
    mockIngest(200, { net_worth: 12345 });
    const res = await app.request("/money/net-worth/summary");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test-ingest:5555/api/net-worth/summary",
    );
    expect(res.status).toBe(200);
  });

  it("GET /money/net-worth/history forwards date range", async () => {
    mockIngest(200, { series: [] });
    await app.request("/money/net-worth/history?start=2025-01-01&end=2026-01-01");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith("http://test-ingest:5555/api/net-worth/history?")).toBe(true);
    expect(url).toContain("start=2025-01-01");
  });

  it("GET /money/performance forwards filters", async () => {
    mockIngest(200, { series: [] });
    await app.request("/money/performance?account_id=acct_x");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test-ingest:5555/api/performance?account_id=acct_x",
    );
  });

  it("GET /money/spending/summary forwards range param", async () => {
    mockIngest(200, { summary: {} });
    await app.request("/money/spending/summary?range=month");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test-ingest:5555/api/spending/summary?range=month",
    );
  });

  it("GET /money/holdings forwards account_id", async () => {
    mockIngest(200, { holdings: [] });
    await app.request("/money/holdings?account_id=acct_x");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test-ingest:5555/api/holdings?account_id=acct_x",
    );
  });

  it("GET /money/allocation maps cleanly", async () => {
    mockIngest(200, { allocation: {} });
    await app.request("/money/allocation");
    expect(fetchMock.mock.calls[0][0]).toBe("http://test-ingest:5555/api/allocation");
  });

  it("GET /money/recurring maps cleanly", async () => {
    mockIngest(200, { patterns: [] });
    await app.request("/money/recurring");
    expect(fetchMock.mock.calls[0][0]).toBe("http://test-ingest:5555/api/recurring");
  });

  it("GET /money/institutions and /money/people map cleanly", async () => {
    mockIngest(200, { institutions: [] });
    await app.request("/money/institutions");
    expect(fetchMock.mock.calls[0][0]).toBe("http://test-ingest:5555/api/institutions");

    mockIngest(200, { people: [] });
    await app.request("/money/people");
    expect(fetchMock.mock.calls[1][0]).toBe("http://test-ingest:5555/api/people");
  });

  it("forwards ingest 4xx errors with original status and body", async () => {
    mockIngest(400, { error: "missing 'institution' parameter" });
    const res = await app.request("/money/last-sync");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing 'institution' parameter" });
  });

  it("returns 502 when ingest is unreachable (TypeError on fetch)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("ECONNREFUSED"));
    const res = await app.request("/money/accounts");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("defaults INGEST_BASE to in-cluster service URL when env unset", async () => {
    delete process.env.INGEST_BASE;
    // Re-import to pick up the new env? The module reads env at request time.
    mockIngest(200, {});
    await app.request("/money/accounts");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith("http://ingest.homelab.svc.cluster.local:5555")).toBe(true);
  });
});
