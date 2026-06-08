/**
 * Unit tests for the Coach agent manager.
 *
 * We do NOT call into the real Anthropic SDK — the `runQuery` dep is
 * stubbed with a controllable async iterable. The PB dep is stubbed with
 * a minimal pass-through (`getPb` returns a plain object — the
 * SessionStore is constructed but never actually called in these tests
 * because the stub SDK doesn't call `sessionStore.append`).
 *
 * What we test:
 *   1. `pushMessage` queues a user message and the SDK sees it.
 *   2. Per-user session caching — the same ownerId reuses one session.
 *   3. Distinct owners get distinct sessions.
 *   4. Assistant text emitted by the (mock) SDK triggers a writeback POST.
 *   5. Writeback failures are caught — they don't crash the consumer loop.
 *   6. Result-level errors emitted by the SDK become "error"-kind writebacks.
 *   7. Warm-context fires on the FIRST message per owner per pod and is
 *      skipped on subsequent messages (per-pod set).
 *   8. Concurrent `pushMessage` calls for the same ownerId during the
 *      async session-create window share one session (in-flight dedup).
 */
import { describe, it, expect } from "vitest";
import type PocketBase from "pocketbase";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { buildQueryOptions, createAgentManager, type AgentDeps } from "./agent.js";

// ─── Test harness ────────────────────────────────────────────────────────────

interface StubSession {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
  /** Push an assistant text response from the test side. */
  emitAssistantText: (text: string) => void;
  /**
   * Same as emitAssistantText but also stamps a BetaUsage on
   * `message.usage` — used by the token-attribution tests.
   */
  emitAssistantTextWithUsage: (
    text: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    },
  ) => void;
  /** Emit a result-level error so error-writeback paths fire. */
  emitResultError: (subtype: string, errors: string[]) => void;
  /** Close the stream so the consumer loop exits cleanly. */
  close: () => void;
}

/**
 * Build a stub SDK `Query` plus a controller the test uses to drive it.
 * We hold the resolve callback for the pending message-yield promise so
 * the test can push messages into the consumer loop at deterministic
 * points.
 */
function makeStubRunQuery(): {
  runQuery: AgentDeps["runQuery"];
  sessions: StubSession[];
} {
  const sessions: StubSession[] = [];

  const runQuery: AgentDeps["runQuery"] = (params) => {
    const pending: SDKMessage[] = [];
    let resolveWait: (() => void) | null = null;
    let closed = false;

    const wake = () => {
      const fire = resolveWait;
      resolveWait = null;
      if (fire) fire();
    };

    const stub: StubSession = {
      prompt: params.prompt as AsyncIterable<SDKUserMessage>,
      options: params.options,
      emitAssistantText(text) {
        pending.push({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
          parent_tool_use_id: null,
          uuid: `assist-${pending.length}` as never,
          session_id: "test-sess" as never,
        } as unknown as SDKMessage);
        wake();
      },
      emitAssistantTextWithUsage(text, usage) {
        pending.push({
          type: "assistant",
          message: {
            content: [{ type: "text", text }],
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            },
          },
          parent_tool_use_id: null,
          uuid: `assist-${pending.length}` as never,
          session_id: "test-sess" as never,
        } as unknown as SDKMessage);
        wake();
      },
      emitResultError(subtype, errors) {
        pending.push({
          type: "result",
          subtype,
          errors,
        } as unknown as SDKMessage);
        wake();
      },
      close() {
        closed = true;
        wake();
      },
    };
    sessions.push(stub);

    // The SDK's Query is an AsyncGenerator + control methods. We only
    // implement enough surface for the agent consumer loop: the async
    // iterator, plus `close()` so the manager's shutdown path works.
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      while (!closed) {
        while (pending.length > 0) {
          const m = pending.shift();
          if (m) yield m;
        }
        if (closed) break;
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
    }
    const iter = gen();
    const query: Partial<Query> = {
      [Symbol.asyncIterator]: () => iter,
      next: () => iter.next(),
      return: (value) => iter.return(value),
      throw: (err) => iter.throw(err),
      close: () => {
        closed = true;
        wake();
      },
    };
    return query as Query;
  };

  return { runQuery, sessions };
}

/** Stub PB just enough to satisfy `PocketBaseSessionStore` construction. */
function stubPb(): PocketBase {
  return {} as PocketBase;
}

/**
 * A `now()` source that advances by `step` ms each call. Tests that
 * push multiple messages need to either (a) override `now` so the
 * 6s min-interval rate limit doesn't throttle the 2nd push, or
 * (b) wait 6+ seconds of real time. We pick (a).
 */
function fastClock(step = 10_000): () => number {
  let t = 1_700_000_000_000;
  return () => {
    const out = t;
    t += step;
    return out;
  };
}

/**
 * Default test deps. `buildWarmContext` returns null so the synthetic
 * warm-context message doesn't appear in the inbox (most tests don't care
 * about it). The warm-context-specific tests override. `now` jumps ahead
 * 10s/call so the 6s min-interval rate limit is never the thing under
 * test — rate-limit-specific tests override.
 */
function baseDeps(overrides: Partial<AgentDeps>): AgentDeps {
  return {
    runQuery: () => {
      throw new Error("runQuery not stubbed");
    },
    getPb: async () => stubPb(),
    postAssistantMessage: async () => {},
    buildWarmContext: async () => null,
    now: fastClock(),
    ...overrides,
  };
}

/** Tiny helper to wait one event-loop tick so emitted messages can flow. */
const tick = (n = 1) =>
  new Promise<void>((resolve) => {
    let count = 0;
    const drain = () => {
      count += 1;
      if (count >= n) resolve();
      else setImmediate(drain);
    };
    setImmediate(drain);
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createAgentManager", () => {
  it("queues a pushed user message into the SDK inbox generator", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const manager = createAgentManager(baseDeps({ runQuery }));

    await manager.pushMessage("user-a", "hello");

    // Pull the first message off the generator the SDK was handed.
    expect(sessions).toHaveLength(1);
    const it = sessions[0].prompt[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe("user");
    expect(
      typeof first.value?.message?.content === "string"
        ? first.value.message.content
        : "",
    ).toBe("hello");

    manager.closeAll();
  });

  it("reuses the same session for repeated messages from one owner", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const manager = createAgentManager(baseDeps({ runQuery }));

    await manager.pushMessage("user-a", "one");
    await manager.pushMessage("user-a", "two");
    await manager.pushMessage("user-a", "three");

    // Only one session was started for the same owner.
    expect(sessions).toHaveLength(1);
    expect(manager.activeSessionCount()).toBe(1);

    manager.closeAll();
  });

  it("creates distinct sessions for different owners", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const manager = createAgentManager(baseDeps({ runQuery }));

    await manager.pushMessage("user-a", "alpha");
    await manager.pushMessage("user-b", "beta");

    expect(sessions).toHaveLength(2);
    expect(manager.activeSessionCount()).toBe(2);

    manager.closeAll();
  });

  it("posts assistant text back via the writeback dep", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const posts: Array<{ owner: string; body: string; kind?: string }> = [];

    const manager = createAgentManager(
      baseDeps({
        runQuery,
        postAssistantMessage: async (owner, body, kind) => {
          posts.push({ owner, body, kind });
        },
      }),
    );

    await manager.pushMessage("user-a", "what's up");
    // Stub SDK emits an assistant reply.
    sessions[0].emitAssistantText("not much");

    // Let the consumer loop drain the emitted message.
    await tick(4);

    expect(posts).toEqual([{ owner: "user-a", body: "not much", kind: "chat" }]);

    manager.closeAll();
  });

  it("does not crash when the writeback dep throws", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    let firstCall = true;
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        postAssistantMessage: async () => {
          if (firstCall) {
            firstCall = false;
            throw new Error("simulated 500");
          }
        },
      }),
    );

    await manager.pushMessage("user-a", "go");
    sessions[0].emitAssistantText("first reply"); // → throws inside writeback
    await tick(4);
    sessions[0].emitAssistantText("second reply"); // → succeeds
    await tick(4);

    expect(manager.lastError()).toContain("simulated 500");
    expect(manager.activeSessionCount()).toBe(1);

    manager.closeAll();
  });

  it("posts an error-kind chat message when SDK emits a result-error", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const posts: Array<{ owner: string; body: string; kind?: string }> = [];
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        postAssistantMessage: async (owner, body, kind) => {
          posts.push({ owner, body, kind });
        },
      }),
    );

    await manager.pushMessage("user-a", "trigger error");
    sessions[0].emitResultError("error_max_turns", ["over the limit"]);
    await tick(4);

    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe("error");
    expect(posts[0].body).toContain("error_max_turns");

    manager.closeAll();
  });

  it("injects warm-context on the first message per owner per pod", async () => {
    const { runQuery, sessions } = makeStubRunQuery();

    let warmCalls = 0;
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        buildWarmContext: async () => {
          warmCalls += 1;
          return "## Context window: …\n(warm bundle markdown)";
        },
      }),
    );

    await manager.pushMessage("user-a", "hello");
    expect(warmCalls).toBe(1);

    // Pull two messages off the generator: warm-context first, then the
    // real user message.
    const it = sessions[0].prompt[Symbol.asyncIterator]();
    const m1 = await it.next();
    expect(m1.value?.type).toBe("user");
    expect(m1.value?.isSynthetic).toBe(true);
    expect(
      typeof m1.value?.message?.content === "string"
        ? m1.value.message.content
        : "",
    ).toContain("warm bundle markdown");

    const m2 = await it.next();
    expect(m2.value?.isSynthetic).toBeFalsy();
    expect(
      typeof m2.value?.message?.content === "string"
        ? m2.value.message.content
        : "",
    ).toBe("hello");

    manager.closeAll();
  });

  it("does NOT re-inject warm-context on subsequent messages for the same owner", async () => {
    const { runQuery } = makeStubRunQuery();
    let warmCalls = 0;
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        buildWarmContext: async () => {
          warmCalls += 1;
          return "(warm)";
        },
      }),
    );

    await manager.pushMessage("user-a", "one");
    await manager.pushMessage("user-a", "two");
    await manager.pushMessage("user-a", "three");

    // Per-pod primed set — exactly one warm-context call across all three
    // messages because the session is reused.
    expect(warmCalls).toBe(1);

    manager.closeAll();
  });

  it("dedups concurrent pushMessage calls into a single session (race fix)", async () => {
    // Reproduce the race: two pushMessage calls for the same ownerId
    // arrive while getOrCreateSession is mid-await (getPb / buildWarmContext).
    // Without the inflight-promise map, BOTH callers would observe
    // sessions.get(ownerId) === undefined and each spawn its own SDK
    // query() — the second `sessions.set` orphaning the first.
    const { runQuery, sessions } = makeStubRunQuery();

    // Slow getPb so both pushMessage calls observe the empty sessions Map.
    let resolvePb: ((pb: PocketBase) => void) | null = null;
    const pbPromise = new Promise<PocketBase>((resolve) => {
      resolvePb = resolve;
    });
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        getPb: () => pbPromise,
      }),
    );

    // Fire both pushes WITHOUT awaiting — they both enter
    // getOrCreateSession before getPb resolves.
    const p1 = manager.pushMessage("user-a", "first");
    const p2 = manager.pushMessage("user-a", "second");

    // Let microtasks settle so both calls are parked on `await deps.getPb()`.
    await tick(1);

    // Now resolve the pb promise; both create-paths converge on the same
    // inflight promise and end up sharing one session.
    resolvePb!(stubPb());
    await Promise.all([p1, p2]);

    expect(sessions).toHaveLength(1);
    expect(manager.activeSessionCount()).toBe(1);

    // Both messages should be queued in that single session's inbox.
    const it = sessions[0].prompt[Symbol.asyncIterator]();
    const m1 = await it.next();
    const m2 = await it.next();
    const contents = [m1, m2].map((m) =>
      typeof m.value?.message?.content === "string"
        ? m.value.message.content
        : "",
    );
    expect(contents).toEqual(expect.arrayContaining(["first", "second"]));

    manager.closeAll();
  });

  // ─── Guardrails ──────────────────────────────────────────────────────────

  it("throttles a 2nd push inside the min-interval window without spawning an SDK call", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const posts: Array<{ owner: string; body: string; kind?: string }> = [];

    // Clock advances 1s/call — the 2nd push is well under the 6s min-interval.
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        now: fastClock(1000),
        postAssistantMessage: async (owner, body, kind) => {
          posts.push({ owner, body, kind });
        },
      }),
    );

    await manager.pushMessage("user-a", "one");
    await manager.pushMessage("user-a", "two"); // ← should be throttled

    // First push spawned an SDK session; second did not.
    expect(sessions).toHaveLength(1);

    // The throttle refusal was written back as `kind:"error"` (the
    // existing route maps that to a "note" row, see defaultDeps).
    expect(posts).toHaveLength(1);
    expect(posts[0].kind).toBe("error");
    expect(posts[0].body).toMatch(/throttled.*try again/i);

    // The actual SDK inbox should only have the first message.
    const it = sessions[0].prompt[Symbol.asyncIterator]();
    const m1 = await it.next();
    expect(
      typeof m1.value?.message?.content === "string"
        ? m1.value.message.content
        : "",
    ).toBe("one");

    manager.closeAll();
  });

  it("enforces the hourly cap: 61st push is throttled, no extra SDK turn", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const posts: Array<{ owner: string; body: string; kind?: string }> = [];

    // 1 minute/step → 60 pushes span 60 minutes; the 61st falls inside the
    // 60-min trailing window so the cap should trip.
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        now: fastClock(60_000),
        postAssistantMessage: async (owner, body, kind) => {
          posts.push({ owner, body, kind });
        },
      }),
    );

    for (let i = 0; i < 60; i++) {
      await manager.pushMessage("user-a", `msg-${i}`);
    }
    // Pre-condition: no throttle messages yet.
    expect(posts.filter((p) => p.kind === "error")).toHaveLength(0);

    // The 61st push (still in the trailing 60-min window) trips the cap.
    await manager.pushMessage("user-a", "msg-61");

    // Exactly one throttle writeback fired and it mentions the hourly cap.
    const throttles = posts.filter((p) => p.kind === "error");
    expect(throttles).toHaveLength(1);
    expect(throttles[0].body).toMatch(/last hour/i);

    // Only one SDK session was spawned (per ownerId), and exactly 60
    // messages made it into the inbox.
    expect(sessions).toHaveLength(1);
    const drained: string[] = [];
    const it = sessions[0].prompt[Symbol.asyncIterator]();
    for (let i = 0; i < 60; i++) {
      const m = await it.next();
      drained.push(
        typeof m.value?.message?.content === "string"
          ? m.value.message.content
          : "",
      );
    }
    expect(drained).toHaveLength(60);
    expect(drained).not.toContain("msg-61");

    manager.closeAll();
  });

  it("passes maxTurns into the SDK query options", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const manager = createAgentManager(baseDeps({ runQuery }));
    await manager.pushMessage("user-a", "hi");

    expect(sessions).toHaveLength(1);
    expect(sessions[0].options?.maxTurns).toBe(8);

    manager.closeAll();
  });

  it("buildQueryOptions respects an explicit maxTurns override", () => {
    const opts = buildQueryOptions(
      "user-a",
      stubPb(),
      "http://mcp.test/mcp",
      "hlk_test",
      3,
    );
    expect(opts.maxTurns).toBe(3);
  });

  it("attributes assistant usage to per-user daily token totals", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    // Pin the clock to a single instant so the daily date is deterministic.
    const fixed = Date.UTC(2026, 5, 8, 18, 0, 0); // 2026-06-08 18:00 UTC ≈ 11:00 PT
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        now: () => fixed,
      }),
    );

    await manager.pushMessage("user-a", "hello");

    // Push two assistant messages with usage fields; the manager should
    // sum them into the user's daily totals.
    sessions[0].emitAssistantTextWithUsage("first reply", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    });
    sessions[0].emitAssistantTextWithUsage("second reply", {
      input_tokens: 200,
      output_tokens: 75,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    });
    await tick(8);

    const stats = manager.tokenStats();
    expect(stats["user-a"]).toBeDefined();
    expect(stats["user-a"].in).toBe(300);
    expect(stats["user-a"].out).toBe(125);
    expect(stats["user-a"].cache_read).toBe(50);
    expect(stats["user-a"].cache_creation).toBe(15);
    expect(stats["user-a"].turns).toBe(2);
    // Date is the Pacific calendar day (2026-06-08 at 11:00 PT).
    expect(stats["user-a"].date).toBe("2026-06-08");

    manager.closeAll();
  });

  it("resets daily token totals when the Pacific calendar date rolls over", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    // First emit at 11:00 PT on day 1; second at 11:00 PT on day 2.
    let t = Date.UTC(2026, 5, 8, 18, 0, 0);
    const manager = createAgentManager(
      baseDeps({
        runQuery,
        now: () => t,
      }),
    );

    await manager.pushMessage("user-a", "hello");
    sessions[0].emitAssistantTextWithUsage("day-1", {
      input_tokens: 100,
      output_tokens: 50,
    });
    await tick(4);
    expect(manager.tokenStats()["user-a"].in).toBe(100);
    expect(manager.tokenStats()["user-a"].date).toBe("2026-06-08");

    // Roll forward 24h → next Pacific day.
    t = Date.UTC(2026, 5, 9, 18, 0, 0);
    sessions[0].emitAssistantTextWithUsage("day-2", {
      input_tokens: 999,
      output_tokens: 1,
    });
    await tick(4);
    expect(manager.tokenStats()["user-a"].in).toBe(999);
    expect(manager.tokenStats()["user-a"].out).toBe(1);
    expect(manager.tokenStats()["user-a"].turns).toBe(1);
    expect(manager.tokenStats()["user-a"].date).toBe("2026-06-09");

    manager.closeAll();
  });

  it("tokenStats() returns shallow clones, not live references", async () => {
    const { runQuery, sessions } = makeStubRunQuery();
    const manager = createAgentManager(baseDeps({ runQuery }));
    await manager.pushMessage("user-a", "hi");
    sessions[0].emitAssistantTextWithUsage("reply", {
      input_tokens: 10,
      output_tokens: 5,
    });
    await tick(4);

    const snap = manager.tokenStats();
    snap["user-a"].in = 99999;
    // Re-querying should give the real value back, not the mutated one.
    expect(manager.tokenStats()["user-a"].in).toBe(10);

    manager.closeAll();
  });
});
