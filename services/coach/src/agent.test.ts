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

import { createAgentManager, type AgentDeps } from "./agent.js";

// ─── Test harness ────────────────────────────────────────────────────────────

interface StubSession {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
  /** Push an assistant text response from the test side. */
  emitAssistantText: (text: string) => void;
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
 * Default test deps. `buildWarmContext` returns null so the synthetic
 * warm-context message doesn't appear in the inbox (most tests don't care
 * about it). The warm-context-specific tests override.
 */
function baseDeps(overrides: Partial<AgentDeps>): AgentDeps {
  return {
    runQuery: () => {
      throw new Error("runQuery not stubbed");
    },
    getPb: async () => stubPb(),
    postAssistantMessage: async () => {},
    buildWarmContext: async () => null,
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
});
