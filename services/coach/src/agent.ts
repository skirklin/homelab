/**
 * Per-user Coach agent — owns the SDK `query()` loop, an inbox queue, and
 * the writeback path back to the chat collection.
 *
 * Shape:
 *   - One `UserSession` per `(ownerId, threadId)` pair. Sessions are cached
 *     in a `Map<string, UserSession>` keyed by `${ownerId}::${threadId}`.
 *     Threads are independent conversations (the "pm" PM-iteration channel
 *     vs. "obs:<id>" per-observation reply threads) and they MUST NOT share
 *     SDK transcript state — that contamination is the bug this refactor
 *     exists to fix. Keying on the pair is the structural fix: two threads
 *     can't see each other's history even by accident.
 *   - Each session pumps user messages into the SDK via streaming-input
 *     mode (`prompt: AsyncIterable<SDKUserMessage>`) — the inbox queue +
 *     notify primitive is owned by us because the SDK has no native
 *     "push from outside into a running query" call.
 *   - A consumer task drains the SDK's response stream and writes
 *     assistant text back as new `chat_messages` rows via the existing
 *     `POST /chat/messages` route (in-cluster URL). The writeback carries
 *     the same `thread_id` the session is responding in, so replies stay
 *     in their thread.
 *
 * What is NOT per-thread:
 *   - Token stats: keyed by ownerId only. We pay for tokens regardless of
 *     which thread spent them.
 *   - Rate limit: keyed by ownerId only. Protects against runaway from any
 *     thread.
 *
 * The actual SDK module is injected (`AgentDeps.runQuery`) so unit tests
 * can swap in a mock without paying real Anthropic calls.
 *
 * Manual smoke test (NOT in CI — burns credits):
 *
 *   PB_URL=http://127.0.0.1:8090 \
 *   PB_ADMIN_EMAIL=... \
 *   PB_ADMIN_PASSWORD=... \
 *   HOMELAB_API_TOKEN=hlk_... \
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   COACH_WRITEBACK_URL=http://127.0.0.1:3000/chat/messages \
 *   pnpm --filter @homelab/coach dev
 *
 *   # then POST a user message to chat_messages (with thread_id="pm" or
 *   # thread_id="obs:<id>") via the homelab API and watch the assistant
 *   # reply arrive in the same thread within a few seconds.
 */
import type PocketBase from "pocketbase";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

import { PocketBaseSessionStore } from "./session-store.js";
import { COACH_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  ALLOWED_TOOLS,
  BUILTIN_TOOL_SURFACE,
  DISALLOWED_TOOLS,
  isToolAllowed,
} from "./tool-policy.js";
import { buildWarmContextMessage } from "./warm-context.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Injectable surface for the SDK + writeback HTTP call. Tests pass mocks;
 * production passes the real implementations.
 */
export interface AgentDeps {
  /** SDK `query()` — wrapped so tests can stub it. */
  runQuery: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
  /** Admin-PB factory used by the SessionStore. */
  getPb: () => Promise<PocketBase>;
  /**
   * POST an assistant message back to /chat/messages. Awaited so we can
   * log failures. The `threadId` must match the thread the originating
   * user message was in — the writeback must stay in its thread.
   */
  postAssistantMessage: (
    ownerId: string,
    threadId: string,
    body: string,
    kind?: "chat" | "error",
  ) => Promise<void>;
  /**
   * Build the synthetic warm-context user message. Defaults to the
   * bundle-based implementation. Tests override (or stub to return null).
   *
   * Called once per `(ownerId, threadId)` pair per pod lifetime (the first
   * time a session is created for that pair in this process). The SDK
   * session is always fresh on pod startup — we don't wire `resume:` —
   * and a new pair always means a fresh SDK transcript, so warm-context
   * is correct to inject every time. The bundle itself is the user's
   * life data (same across threads), but the SDK transcript is per-thread
   * so we have to re-inject it on the first turn of each thread.
   */
  buildWarmContext?: (pb: PocketBase, ownerId: string) => Promise<string | null>;
  /**
   * Wall-clock source. Defaults to `Date.now`. Tests override to drive
   * the rate-limit windows deterministically without sleeping.
   */
  now?: () => number;
}

/** Per-user daily token totals. Resets when `date` changes. */
export interface TokenStats {
  /** Pacific calendar date (`YYYY-MM-DD`) the counters are scoped to. */
  date: string;
  in: number;
  out: number;
  cache_read: number;
  cache_creation: number;
  /** Number of completed assistant turns counted toward this day. */
  turns: number;
}

interface UserSession {
  ownerId: string;
  /**
   * Thread this session is responding in (e.g. "pm" or "obs:<id>"). Stamped
   * once at create-time; the consumer loop reads it on every writeback so
   * assistant replies land in the right thread without each push having to
   * carry the threadId through the inbox.
   */
  threadId: string;
  query: Query;
  inbox: SDKUserMessage[];
  notify: (() => void) | null;
  /** Number of completed assistant turns (test introspection, not strictly needed). */
  assistantTurns: number;
  /** Last error message, if any, from a failed turn. Used by /health. */
  lastError: string | null;
  /** Set when the consumer loop exits (SDK closed). */
  closed: boolean;
}

export interface AgentManager {
  /**
   * Push a user message into the session for `(ownerId, threadId)`.
   * Creates the session if needed. Two distinct threadIds for the same
   * ownerId get distinct SDK sessions and distinct warm-context windows
   * — see the file-level comment for why.
   */
  pushMessage: (ownerId: string, threadId: string, body: string) => Promise<void>;
  /** Returns the current count of active sessions — used by /health. */
  activeSessionCount: () => number;
  /** Returns the last per-session error (across all sessions), if any. */
  lastError: () => string | null;
  /**
   * Returns a snapshot of per-user daily token totals. Resets when the
   * Pacific calendar date rolls over. In-memory only — pod restart loses
   * the counters, which is fine (next day starts fresh anyway).
   */
  tokenStats: () => Record<string, TokenStats>;
  /** Test/shutdown hook: close every active session and clear the map. */
  closeAll: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the assistant's user-visible text from an SDK assistant message.
 * The SDK delivers content as a Beta `content` array of blocks; we want
 * the concatenated text from any `text` blocks (ignoring `tool_use`,
 * `thinking`, etc.).
 */
function extractAssistantText(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text") {
      const text = (block as { type: "text"; text?: string }).text;
      if (typeof text === "string" && text.length > 0) parts.push(text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("");
}

/** Default warm-context builder — uses the bundle assembler. */
async function defaultBuildWarmContext(
  pb: PocketBase,
  ownerId: string,
): Promise<string | null> {
  return buildWarmContextMessage({ pb, ownerId });
}

/**
 * Today's calendar day in Pacific time as `YYYY-MM-DD`. Mirrors
 * `services/api/src/lib/notifications/tz.ts#todayPacific` — Scott (the
 * only Coach user for v1) reads the day in PT, so the daily token
 * counter rolls over at PT midnight rather than UTC midnight.
 */
function todayPacific(now: number): string {
  return new Date(now).toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
}

/**
 * Pull the BetaUsage off an SDK assistant message. The SDK delivers it
 * at `msg.message.usage` (BetaMessage), where every field except
 * input_tokens/output_tokens may be null. Returns null if usage is
 * absent (e.g. a streamed chunk before the final usage block lands).
 */
function extractAssistantUsage(msg: SDKMessage): {
  in: number;
  out: number;
  cache_read: number;
  cache_creation: number;
} | null {
  if (msg.type !== "assistant") return null;
  // Cast through unknown: the SDK's BetaMessage is a deep type tree, and
  // we only need four fields off `.usage`. A narrow shape keeps the
  // dependency surface minimal.
  const u = (msg as unknown as { message?: { usage?: Record<string, number | null> } })
    .message?.usage;
  if (!u) return null;
  return {
    in: typeof u.input_tokens === "number" ? u.input_tokens : 0,
    out: typeof u.output_tokens === "number" ? u.output_tokens : 0,
    cache_read:
      typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
    cache_creation:
      typeof u.cache_creation_input_tokens === "number"
        ? u.cache_creation_input_tokens
        : 0,
  };
}

// ─── Rate-limit + budget config ──────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

/**
 * Read the guardrail config from env at call time. Re-evaluating per
 * `createAgentManager` (rather than caching at module load) lets tests
 * set env vars in `beforeEach` without import-order gymnastics, and
 * lets the prod boot path pick up changes from a Deployment env edit on
 * the next pod start without code edits.
 */
function readGuardrailConfig(): {
  minIntervalMs: number;
  hourlyCap: number;
  maxTurns: number;
} {
  const minVal = Number(process.env.COACH_TURN_MIN_INTERVAL_MS);
  const capVal = Number(process.env.COACH_TURN_HOURLY_CAP);
  const turnsVal = Number(process.env.COACH_MAX_TURNS);
  return {
    minIntervalMs: Number.isFinite(minVal) && minVal >= 0 ? minVal : 6000,
    hourlyCap: Number.isFinite(capVal) && capVal > 0 ? capVal : 60,
    maxTurns: Number.isFinite(turnsVal) && turnsVal > 0 ? turnsVal : 8,
  };
}

/**
 * Build the SDK `Options` for a given user. Pulled out so tests can
 * assert on the exact shape without spinning up the real SDK.
 */
export function buildQueryOptions(
  ownerId: string,
  pb: PocketBase,
  homelabMcpUrl: string,
  homelabApiToken: string,
  maxTurns: number = readGuardrailConfig().maxTurns,
): Options {
  return {
    // V0 system prompt — sparse voice. Iterate freely in
    // `services/coach/src/system-prompt.ts`.
    systemPrompt: COACH_SYSTEM_PROMPT,

    // Mirror SDK transcripts to PB via the D1 adapter. Each user gets their
    // own SessionStore instance bound to their ownerId — tenancy is enforced
    // inside the adapter, not the SDK.
    sessionStore: new PocketBaseSessionStore({ pb, ownerId }),

    // Don't load filesystem settings, .mcp.json, or CLAUDE.md from cwd.
    // We're a backend service; all config flows in here programmatically.
    settingSources: [],

    // Only honor the MCP servers we pass here — no project/.mcp.json,
    // no agent-frontmatter MCP. Defense in depth so a stray file on disk
    // can't change the agent's reach.
    strictMcpConfig: true,

    // Programmatic MCP wiring. The homelab MCP over Streamable HTTP runs
    // on the tailnet endpoint; same `hlk_` API token used elsewhere.
    mcpServers: {
      homelab: {
        type: "http",
        url: homelabMcpUrl,
        headers: { Authorization: `Bearer ${homelabApiToken}` },
      },
    },

    // Curated tool surface — see `tool-policy.ts`.
    //
    // `tools` actually RESTRICTS the model's built-in tool surface (sdk.d.ts
    // line ~1378). `allowedTools` only auto-approves without prompting — it's
    // a UX gate, not a visibility one (sdk.d.ts ~1324). Without `tools`, the
    // model still sees Bash/Read/Write/Edit/Grep/Glob/etc. in its context
    // and wastes tokens trying them before `canUseTool` denies each one.
    //
    // MCP tools (mcp__homelab__*) come via `mcpServers` and are NOT listed
    // here — `tools` is only for built-ins. The MCP server-side allow/deny
    // (`canUseTool` + `disallowedTools`) is the effective gate for those.
    tools: BUILTIN_TOOL_SURFACE,
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,

    // Per-call gating: anything that slipped past the allow/deny lists
    // gets a hard deny here. `isToolAllowed` is default-deny.
    canUseTool: async (toolName) => {
      if (!isToolAllowed(toolName)) {
        return {
          behavior: "deny",
          message: `Tool '${toolName}' is not in the Coach policy allowlist.`,
        };
      }
      return { behavior: "allow" };
    },

    // Standard permission mode — anything the agent can't justify gets
    // denied via canUseTool above.
    permissionMode: "default",

    // Cap internal tool-use rounds per user turn. If the model hits this
    // ceiling the SDK emits a result message with
    // `subtype: "error_max_turns"`, which our consumer loop already
    // surfaces as an in-chat error note. Protects against per-turn
    // tool-loops (search → fetch → search → ...) burning credits on a
    // single user message. Tunable via `COACH_MAX_TURNS`.
    maxTurns,
  };
}

// ─── User session creation ───────────────────────────────────────────────────

/**
 * Build an async generator backed by an inbox + notify primitive. Yields
 * queued user messages and parks when the queue is empty, waking when
 * `notify` is called by `pushMessage`.
 */
function makeInboxGenerator(
  session: Pick<UserSession, "inbox" | "notify">,
): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return (async function* () {
        while (true) {
          while (session.inbox.length > 0) {
            const m = session.inbox.shift();
            if (m) yield m;
          }
          await new Promise<void>((resolve) => {
            session.notify = resolve;
          });
        }
      })();
    },
  };
}

/**
 * Build the manager. Public entry point — `index.ts` calls this once at
 * service boot and shares the returned `AgentManager` with the chat
 * subscriber.
 *
 * `MCP_URL` and `MCP_TOKEN` are read from env at construction time
 * (sensible default: tailnet endpoint + `HOMELAB_API_TOKEN`). Failing
 * fast on missing env is the caller's responsibility (`index.ts`).
 */
export function createAgentManager(deps: AgentDeps): AgentManager {
  // Sessions are keyed by `${ownerId}::${threadId}`. The double-colon
  // separator is safe because thread ids in this system are either bare
  // names like "pm" or use a single-colon `<kind>:<id>` scheme, so a
  // literal "::" can't show up inside an ownerId or threadId by accident.
  const sessions = new Map<string, UserSession>();
  // Concurrent `pushMessage` calls for the same (ownerId, threadId) can
  // both observe `sessions.get(key) === undefined` during the async setup
  // window (PB connect + warm-context fetch + SDK spawn). Without this map
  // the second caller spawns a second SDK `query()` and orphans the first;
  // the orphan keeps draining its inbox + burning credits forever.
  // Dedup via in-flight promises so concurrent callers await the same
  // create.
  const inflight = new Map<string, Promise<UserSession>>();
  // (ownerId, threadId) pairs whose warm-context has been injected during
  // THIS pod's lifetime. Reset on pod restart, which is correct: the SDK
  // session is also fresh after restart (we don't pass `resume:`). Keyed
  // by the full session key (not bare ownerId) so each thread gets its
  // own warm-context injection — they don't share SDK transcripts.
  const primedThisPod = new Set<string>();

  /** Build the session-cache key. Co-located so the format stays in one place. */
  const sessionKey = (ownerId: string, threadId: string): string =>
    `${ownerId}::${threadId}`;
  const homelabMcpUrl =
    process.env.HOMELAB_MCP_URL || "https://mcp.tail56ca88.ts.net/mcp";
  const homelabApiToken = process.env.HOMELAB_API_TOKEN || "";

  // Rate-limit state. A "turn" here is one user→SDK push (one `pushMessage`
  // call), NOT the SDK's internal tool-use rounds (those are capped by
  // `maxTurns` on the query). The two limits stack:
  //   - `lastTurnAt`     enforces a minimum gap between pushes per user.
  //   - `recentTurnsAt`  caps total pushes in any trailing-hour window.
  // Both maps are keyed by ownerId; entries live for the pod's lifetime.
  const lastTurnAt = new Map<string, number>();
  const recentTurnsAt = new Map<string, number[]>();
  const { minIntervalMs, hourlyCap, maxTurns } = readGuardrailConfig();

  // Per-user daily token totals. Keyed by ownerId; the `date` field is the
  // Pacific calendar date the counters are scoped to — when it rolls over,
  // the entry is replaced with a fresh zeroed one on the next attribution.
  const tokenStats = new Map<string, TokenStats>();

  const now = () => (deps.now ? deps.now() : Date.now());

  let lastError: string | null = null;

  async function buildSession(ownerId: string, threadId: string): Promise<UserSession> {
    const key = sessionKey(ownerId, threadId);
    const pb = await deps.getPb();
    const session: UserSession = {
      ownerId,
      threadId,
      // Placeholder; replaced below after we have the generator wired.
      query: null as unknown as Query,
      inbox: [],
      notify: null,
      assistantTurns: 0,
      lastError: null,
      closed: false,
    };

    // Warm-context injection — first time we see this (ownerId, threadId)
    // pair in THIS pod. Rationale:
    //   - SDK session is always fresh after pod restart (no `resume:` wire),
    //     so the running transcript has nothing in it.
    //   - Each thread gets its own SDK session, so a fresh thread also has
    //     nothing in its transcript even if other threads for the same
    //     owner have been primed already in this pod.
    //   - The bundle itself is the user's life data (same content across
    //     threads); only the transcript injection point differs.
    //   - Per-pod scoping matches the SDK session's actual lifetime.
    if (!primedThisPod.has(key)) {
      const warmCtx = await (deps.buildWarmContext ?? defaultBuildWarmContext)(
        pb,
        ownerId,
      );
      if (warmCtx) {
        const warmMsg: SDKUserMessage = {
          type: "user",
          message: { role: "user", content: warmCtx },
          parent_tool_use_id: null,
          isSynthetic: true,
          // shouldQuery=false → message lands in transcript without
          // triggering an assistant turn on its own; the next real user
          // message wakes the model with this context attached.
          shouldQuery: false,
        };
        session.inbox.push(warmMsg);
      }
      primedThisPod.add(key);
    }

    const options = buildQueryOptions(
      ownerId,
      pb,
      homelabMcpUrl,
      homelabApiToken,
      maxTurns,
    );
    session.query = deps.runQuery({
      prompt: makeInboxGenerator(session),
      options,
    });

    // Consumer task: drain SDK output, write assistant messages back to
    // the SAME thread the session is responding in.
    (async () => {
      try {
        for await (const msg of session.query) {
          if (msg.type === "assistant") {
            // Attribute the assistant turn's token usage to the user's
            // daily totals BEFORE writeback. Doing it pre-writeback means
            // the counter advances even if writeback fails — credits were
            // already spent on the model call. Token stats are keyed by
            // ownerId only (we pay for tokens regardless of which thread
            // spent them).
            const usage = extractAssistantUsage(msg);
            if (usage) {
              const today = todayPacific(now());
              const cur = tokenStats.get(ownerId);
              const stats: TokenStats =
                cur && cur.date === today
                  ? cur
                  : { date: today, in: 0, out: 0, cache_read: 0, cache_creation: 0, turns: 0 };
              stats.in += usage.in;
              stats.out += usage.out;
              stats.cache_read += usage.cache_read;
              stats.cache_creation += usage.cache_creation;
              stats.turns += 1;
              tokenStats.set(ownerId, stats);
              console.log(
                `[coach/usage] user=${ownerId} thread=${threadId} ` +
                  `in=${usage.in} out=${usage.out} ` +
                  `cache_read=${usage.cache_read} cache_creation=${usage.cache_creation} ` +
                  `turns_today=${stats.turns}`,
              );
            }
            const text = extractAssistantText(msg);
            if (text) {
              try {
                await deps.postAssistantMessage(ownerId, threadId, text, "chat");
                session.assistantTurns += 1;
              } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                console.error(
                  `[coach] writeback failed for ${ownerId}/${threadId}:`,
                  errMsg,
                );
                session.lastError = `writeback: ${errMsg}`;
                lastError = session.lastError;
              }
            }
          } else if (msg.type === "result" && msg.subtype !== "success") {
            // SDK reported a result-level error (max_turns, max_budget,
            // execution error). Surface as an in-chat error note so
            // the user sees something happened.
            const desc = `${msg.subtype}${"errors" in msg && Array.isArray(msg.errors) && msg.errors.length > 0 ? ": " + msg.errors.join("; ") : ""}`;
            session.lastError = desc;
            lastError = desc;
            // `error_max_turns` means the per-user-message tool-use round
            // cap (COACH_MAX_TURNS) tripped. Worth logging at info level
            // separately so it stands out from genuine errors when grepping
            // pod logs ("did we hit the safety net or did something break?").
            if (msg.subtype === "error_max_turns") {
              console.log(
                `[coach/maxturns] user=${ownerId} thread=${threadId} hit COACH_MAX_TURNS=${maxTurns}`,
              );
            }
            console.error(
              `[coach] SDK result error for ${ownerId}/${threadId}:`,
              desc,
            );
            try {
              await deps.postAssistantMessage(
                ownerId,
                threadId,
                `Coach hit an error during this turn: ${desc}`,
                "error",
              );
            } catch (e) {
              console.error(
                `[coach] error-writeback failed for ${ownerId}/${threadId}:`,
                e,
              );
            }
          }
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(
          `[coach] SDK stream errored for ${ownerId}/${threadId}:`,
          errMsg,
        );
        session.lastError = errMsg;
        lastError = errMsg;
        try {
          await deps.postAssistantMessage(
            ownerId,
            threadId,
            `Coach hit an error: ${errMsg}`,
            "error",
          );
        } catch (postErr) {
          console.error(
            `[coach] error-writeback failed for ${ownerId}/${threadId}:`,
            postErr,
          );
        }
      } finally {
        session.closed = true;
      }
    })();

    sessions.set(key, session);
    return session;
  }

  async function getOrCreateSession(
    ownerId: string,
    threadId: string,
  ): Promise<UserSession> {
    const key = sessionKey(ownerId, threadId);
    const existing = sessions.get(key);
    if (existing && !existing.closed) return existing;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = buildSession(ownerId, threadId);
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * Check both rate limits for `ownerId`. Returns null if the turn is
   * allowed (and records it as accepted); otherwise returns a
   * human-readable throttle reason string that the caller surfaces as a
   * `kind:"note"` chat message. The hourly window is pruned in-place so
   * the array doesn't grow unbounded.
   */
  function checkRateLimit(ownerId: string): string | null {
    const t = now();

    // Min-interval gate: hard floor on push frequency. The runaway
    // scenario we're guarding against is a buggy PB realtime / chat
    // subscriber re-firing the same turn in a tight loop — even a 6s
    // floor caps that at 10 turns/min instead of unbounded.
    const last = lastTurnAt.get(ownerId);
    if (last !== undefined && t - last < minIntervalMs) {
      const wait = Math.ceil((minIntervalMs - (t - last)) / 1000);
      return `Throttled: too many turns too fast. Try again in ${wait}s.`;
    }

    // Hourly cap: prune anything older than 1h, then check the window.
    const cutoff = t - HOUR_MS;
    const recent = recentTurnsAt.get(ownerId) ?? [];
    let pruneIdx = 0;
    while (pruneIdx < recent.length && recent[pruneIdx] < cutoff) pruneIdx += 1;
    const trimmed = pruneIdx > 0 ? recent.slice(pruneIdx) : recent;
    if (trimmed.length >= hourlyCap) {
      // Oldest entry in the window dictates when the user can try again.
      const oldest = trimmed[0];
      const wait = Math.max(1, Math.ceil((oldest + HOUR_MS - t) / 1000));
      recentTurnsAt.set(ownerId, trimmed);
      return `Throttled: more than ${hourlyCap} turns in the last hour. Try again in ${wait}s.`;
    }

    // Accept: record the turn.
    trimmed.push(t);
    recentTurnsAt.set(ownerId, trimmed);
    lastTurnAt.set(ownerId, t);
    return null;
  }

  return {
    async pushMessage(ownerId, threadId, body) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        // Defensive: the type signature requires threadId, but the chat
        // subscriber reads it off a raw PB record so we re-check at the
        // entry point. Without this a bad subscriber call would silently
        // land in `sessions[ownerId::]` and never reach the right thread.
        throw new Error(`pushMessage requires a non-empty threadId (got ${JSON.stringify(threadId)})`);
      }
      const throttle = checkRateLimit(ownerId);
      if (throttle) {
        // Do NOT spin up the SDK session for a throttled turn — the
        // whole point is to refuse the work, not just delay it. Post a
        // `kind:"note"` chat row so the user sees the refusal in the
        // SAME thread they sent from, same shape as the existing error
        // writeback.
        console.warn(`[coach/throttle] user=${ownerId} thread=${threadId}: ${throttle}`);
        try {
          await deps.postAssistantMessage(ownerId, threadId, throttle, "error");
        } catch (e) {
          console.error(
            `[coach] throttle-writeback failed for ${ownerId}/${threadId}:`,
            e,
          );
        }
        return;
      }

      const session = await getOrCreateSession(ownerId, threadId);
      const userMsg: SDKUserMessage = {
        type: "user",
        message: { role: "user", content: body },
        parent_tool_use_id: null,
      };
      session.inbox.push(userMsg);
      const fire = session.notify;
      session.notify = null;
      if (fire) fire();
    },
    activeSessionCount() {
      let n = 0;
      for (const s of sessions.values()) if (!s.closed) n += 1;
      return n;
    },
    lastError() {
      return lastError;
    },
    tokenStats() {
      // Shallow-clone each entry so callers (e.g. the /health JSON
      // serializer) can't accidentally mutate live state.
      const out: Record<string, TokenStats> = {};
      for (const [k, v] of tokenStats) out[k] = { ...v };
      return out;
    },
    closeAll() {
      for (const s of sessions.values()) {
        try {
          s.query.close();
        } catch {
          /* swallow — best effort */
        }
        s.closed = true;
      }
      sessions.clear();
    },
  };
}

// ─── Production default deps ─────────────────────────────────────────────────

/**
 * Build the production-default `AgentDeps`. Pulled out of `createAgentManager`
 * so tests don't pay any module-level side effects.
 */
export function defaultDeps(getPb: () => Promise<PocketBase>): AgentDeps {
  const writebackUrl =
    process.env.COACH_WRITEBACK_URL ||
    "http://functions.homelab.svc.cluster.local:3000/chat/messages";
  const homelabApiToken = process.env.HOMELAB_API_TOKEN || "";

  return {
    runQuery: sdkQuery,
    getPb,
    async postAssistantMessage(_ownerId, threadId, body, kind = "chat") {
      // The route stamps `owner` server-side from the auth context — that
      // means the assistant message ends up owned by whichever user the
      // `HOMELAB_API_TOKEN` belongs to. For the single-tenant v1 (Scott
      // only) that's exactly what we want. Multi-tenant requires either
      // a per-user token here or an admin-bypass route variant.
      const res = await fetch(writebackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${homelabApiToken}`,
        },
        body: JSON.stringify({
          thread_id: threadId,
          role: "assistant",
          body,
          // Reuse existing `kind` enum from the chat route. There's no
          // "error" kind in VALID_KINDS yet — fall back to "note" with an
          // inline marker so the UI can still render it. Adding a new
          // enum value would mean a chat-route + PB-enum migration, and
          // for v1 a prefixed "note" is enough.
          kind: kind === "error" ? "note" : "chat",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`writeback ${res.status}: ${text}`);
      }
    },
  };
}
