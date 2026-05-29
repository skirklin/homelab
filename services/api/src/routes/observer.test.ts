/**
 * Unit tests for the observer /generate endpoint.
 *
 * Mocks the bundle module and Anthropic client to test validation,
 * happy path, and PB persistence without external dependencies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../index";
import { observerRoutes } from "./observer";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../lib/observer/bundle", () => ({
  assembleBundle: vi.fn().mockResolvedValue({
    markdown: "## Context window: May 20 – May 27, 2026\n\nSome life data here.",
    relatedEventIds: ["evt1", "evt2"],
  }),
}));

vi.mock("../lib/ai", () => ({
  CLAUDE_MODEL: "claude-test-model",
  getAnthropicClient: vi.fn().mockReturnValue({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "You seem to be sleeping less on days you set ambitious intentions." }],
      }),
    },
  }),
  extractText: vi.fn().mockReturnValue(
    "You seem to be sleeping less on days you set ambitious intentions.",
  ),
}));

import { assembleBundle } from "../lib/observer/bundle";
import { getAnthropicClient } from "../lib/ai";

// ─── Test app with fake auth middleware ──────────────────────────────────────

function buildTestApp(opts?: { userId?: string | null }) {
  const userId = opts?.userId ?? "user_123";
  const createdRecords: unknown[] = [];

  const mockPb = {
    authStore: {
      record: userId ? { id: userId } : null,
    },
    collection: vi.fn().mockReturnValue({
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        const record = { id: "obs_abc", created: "2026-05-27T12:00:00Z", ...data };
        createdRecords.push(record);
        return record;
      }),
    }),
  };

  const app = new Hono<AppEnv>();
  // Fake auth middleware that injects the mock PB
  app.use("*", async (c, next) => {
    c.set("pb", mockPb as unknown as import("pocketbase").default);
    c.set("userId", userId ?? "");
    return next();
  });
  app.route("/observer", observerRoutes);

  return { app, mockPb, createdRecords };
}

async function post(app: Hono<AppEnv>, body: unknown) {
  const res = await app.request("/observer/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /observer/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("input validation", () => {
    it("rejects missing fields", async () => {
      const { app } = buildTestApp();
      const res = await post(app, {});
      expect(res.status).toBe(400);
      const json = await jsonBody(res);
      expect(json.error).toMatch(/missing required fields/i);
    });

    it("rejects missing period", async () => {
      const { app } = buildTestApp();
      const res = await post(app, {
        window_start: "2026-05-20T00:00:00Z",
        window_end: "2026-05-27T00:00:00Z",
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error).toMatch(/missing required fields/i);
    });

    it("rejects invalid period value", async () => {
      const { app } = buildTestApp();
      const res = await post(app, {
        period: "daily",
        window_start: "2026-05-20T00:00:00Z",
        window_end: "2026-05-27T00:00:00Z",
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error).toMatch(/invalid period/i);
    });

    it("rejects invalid window_start date", async () => {
      const { app } = buildTestApp();
      const res = await post(app, {
        period: "weekly",
        window_start: "not-a-date",
        window_end: "2026-05-27T00:00:00Z",
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error).toMatch(/invalid window_start/i);
    });

    it("rejects invalid window_end date", async () => {
      const { app } = buildTestApp();
      const res = await post(app, {
        period: "weekly",
        window_start: "2026-05-20T00:00:00Z",
        window_end: "garbage",
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error).toMatch(/invalid window_end/i);
    });

    it("rejects window_end before window_start", async () => {
      const { app } = buildTestApp();
      const res = await post(app, {
        period: "weekly",
        window_start: "2026-05-27T00:00:00Z",
        window_end: "2026-05-20T00:00:00Z",
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error).toMatch(/window_end must be after/i);
    });

    it("rejects window_end equal to window_start", async () => {
      const { app } = buildTestApp();
      const res = await post(app, {
        period: "adhoc",
        window_start: "2026-05-20T00:00:00Z",
        window_end: "2026-05-20T00:00:00Z",
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error).toMatch(/window_end must be after/i);
    });
  });

  describe("happy path", () => {
    it("calls bundle, sends to Anthropic, persists to PB, and returns the observation", async () => {
      const { app, mockPb, createdRecords } = buildTestApp();

      const res = await post(app, {
        period: "weekly",
        window_start: "2026-05-20T00:00:00Z",
        window_end: "2026-05-27T00:00:00Z",
      });

      expect(res.status).toBe(200);
      const json = await jsonBody(res);

      // Response shape
      expect(json.id).toBe("obs_abc");
      expect(json.content).toContain("sleeping less");
      expect(json.period).toBe("weekly");
      expect(json.data_window_start).toBe("2026-05-20T00:00:00.000Z");
      expect(json.data_window_end).toBe("2026-05-27T00:00:00.000Z");
      expect(json.related_event_ids).toEqual(["evt1", "evt2"]);
      expect(json.prompt_version).toBe("v0");

      // Bundle was called with correct params
      expect(assembleBundle).toHaveBeenCalledOnce();
      const bundleCall = vi.mocked(assembleBundle).mock.calls[0][0];
      expect(bundleCall.windowStart).toEqual(new Date("2026-05-20T00:00:00Z"));
      expect(bundleCall.windowEnd).toEqual(new Date("2026-05-27T00:00:00Z"));

      // Anthropic was called
      const anthropic = getAnthropicClient();
      expect(anthropic.messages.create).toHaveBeenCalledOnce();

      // PB record was created with correct fields
      expect(createdRecords).toHaveLength(1);
      const created = createdRecords[0] as Record<string, unknown>;
      expect(created.content).toContain("sleeping less");
      expect(created.period).toBe("weekly");
      expect(created.owner).toBe("user_123");
      expect(created.prompt_version).toBe("v0");
      expect(created.related_event_ids).toEqual(["evt1", "evt2"]);

      // PB collection was addressed correctly
      expect(mockPb.collection).toHaveBeenCalledWith("claude_observations");
    });

    it("accepts all three valid period values", async () => {
      for (const period of ["weekly", "monthly", "adhoc"]) {
        vi.clearAllMocks();
        const { app } = buildTestApp();
        const res = await post(app, {
          period,
          window_start: "2026-05-20T00:00:00Z",
          window_end: "2026-05-27T00:00:00Z",
        });
        expect(res.status).toBe(200);
        const json = await jsonBody(res);
        expect(json.period).toBe(period);
      }
    });
  });
});
