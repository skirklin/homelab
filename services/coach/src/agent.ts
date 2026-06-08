/**
 * Per-user Coach agent — owns the SDK `query()` loop, an inbox queue, and
 * the writeback path back to the chat collection.
 *
 * Shape:
 *   - One `UserSession` per PB user (`ownerId`). Sessions are cached in a
 *     `Map<string, UserSession>` keyed by ownerId.
 *   - Each session pumps user messages into the SDK via streaming-input
 *     mode (`prompt: AsyncIterable<SDKUserMessage>`) — the inbox queue +
 *     notify primitive is owned by us because the SDK has no native
 *     "push from outside into a running query" call.
 *   - A consumer task drains the SDK's response stream and writes
 *     assistant text back as new `chat_messages` rows via the existing
 *     `POST /chat/messages` route (in-cluster URL).
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
 *   # then POST a user message to chat_messages via the homelab API and
 *   # watch the assistant reply arrive within a few seconds.
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
  DISALLOWED_TOOLS,
  isToolAllowed,
} from "./tool-policy.js";
import {
  buildWarmContextMessage,
  ownerHasPriorSessions,
} from "./warm-context.js";

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
  /** POST an assistant message back to /chat/messages. Awaited so we can log failures. */
  postAssistantMessage: (ownerId: string, body: string, kind?: "chat" | "error") => Promise<void>;
  /**
   * Has the owner ever had a Coach session? Returning true skips
   * warm-context injection so we don't re-prime the agent with the
   * bundle on every pod restart. Defaults to the PB-backed
   * `ownerHasPriorSessions` probe; tests override.
   */
  hasPriorSessions?: (pb: PocketBase, ownerId: string) => Promise<boolean>;
  /**
   * Build the synthetic warm-context user message. Defaults to the
   * bundle-based implementation. Tests override (or stub to return null).
   */
  buildWarmContext?: (pb: PocketBase, ownerId: string) => Promise<string | null>;
}

interface UserSession {
  ownerId: string;
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
  /** Push a user message into the session for `ownerId`. Creates the session if needed. */
  pushMessage: (ownerId: string, body: string) => Promise<void>;
  /** Returns the current count of active sessions — used by /health. */
  activeSessionCount: () => number;
  /** Returns the last per-session error (across all sessions), if any. */
  lastError: () => string | null;
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
 * Build the SDK `Options` for a given user. Pulled out so tests can
 * assert on the exact shape without spinning up the real SDK.
 */
export function buildQueryOptions(
  ownerId: string,
  pb: PocketBase,
  homelabMcpUrl: string,
  homelabApiToken: string,
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
  const sessions = new Map<string, UserSession>();
  const homelabMcpUrl =
    process.env.HOMELAB_MCP_URL || "https://mcp.tail56ca88.ts.net/mcp";
  const homelabApiToken = process.env.HOMELAB_API_TOKEN || "";

  let lastError: string | null = null;

  async function getOrCreateSession(ownerId: string): Promise<UserSession> {
    const existing = sessions.get(ownerId);
    if (existing && !existing.closed) return existing;

    const pb = await deps.getPb();
    const session: UserSession = {
      ownerId,
      // Placeholder; replaced below after we have the generator wired.
      query: null as unknown as Query,
      inbox: [],
      notify: null,
      assistantTurns: 0,
      lastError: null,
      closed: false,
    };

    // Warm-context injection — first-time users get a snapshot of recent
    // life data as a synthetic first message so the agent has a baseline
    // before the conversation starts. Returning users skip this (their
    // prior turns are already in the SDK transcript).
    const hasPrior = await (deps.hasPriorSessions ?? ownerHasPriorSessions)(pb, ownerId);
    if (!hasPrior) {
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
    }

    const options = buildQueryOptions(ownerId, pb, homelabMcpUrl, homelabApiToken);
    session.query = deps.runQuery({
      prompt: makeInboxGenerator(session),
      options,
    });

    // Consumer task: drain SDK output, write assistant messages back.
    (async () => {
      try {
        for await (const msg of session.query) {
          if (msg.type === "assistant") {
            const text = extractAssistantText(msg);
            if (text) {
              try {
                await deps.postAssistantMessage(ownerId, text, "chat");
                session.assistantTurns += 1;
              } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                console.error(`[coach] writeback failed for ${ownerId}:`, errMsg);
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
            console.error(`[coach] SDK result error for ${ownerId}:`, desc);
            try {
              await deps.postAssistantMessage(
                ownerId,
                `Coach hit an error during this turn: ${desc}`,
                "error",
              );
            } catch (e) {
              console.error(`[coach] error-writeback failed for ${ownerId}:`, e);
            }
          }
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[coach] SDK stream errored for ${ownerId}:`, errMsg);
        session.lastError = errMsg;
        lastError = errMsg;
        try {
          await deps.postAssistantMessage(
            ownerId,
            `Coach hit an error: ${errMsg}`,
            "error",
          );
        } catch (postErr) {
          console.error(`[coach] error-writeback failed for ${ownerId}:`, postErr);
        }
      } finally {
        session.closed = true;
      }
    })();

    sessions.set(ownerId, session);
    return session;
  }

  return {
    async pushMessage(ownerId, body) {
      const session = await getOrCreateSession(ownerId);
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
    async postAssistantMessage(_ownerId, body, kind = "chat") {
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
