/**
 * Tool policy for the Coach agent.
 *
 * Two layers, by design:
 *   1. `ALLOWED_TOOLS` — passed to the SDK's `allowedTools` option so the
 *      agent has a curated working set in its context (the CLI auto-permits
 *      these without prompting). Listed by exact tool name — the docs don't
 *      promise glob support in this field, and exact names are unambiguous.
 *   2. `canUseTool` callback (see `isToolAllowed` below) — defense-in-depth
 *      per-call gating. Uses prefix matching so a future MCP-server tool we
 *      forgot to add to `ALLOWED_TOOLS` still gets denied at execution time
 *      if it falls outside the safe set, even if `allowedTools` semantics
 *      drift across SDK versions.
 *
 * Posture: read-only by default. Writes are explicitly enumerated and
 * limited to additive, low-blast-radius operations
 * (`add_life_entry`, `add_task`, `add_travel_note`, `post_chat_message`).
 * Anything matching the destructive prefixes (`delete_`, `remove_`,
 * `clear_`) is explicitly denied even if it slipped into the allowed list.
 *
 * Tool-name reference: `services/api/src/mcp.ts` — every `server.tool("...",
 * ...)` declaration there exposes a tool that surfaces in
 * `mcp__homelab__<name>` on the agent side. List below should stay aligned
 * with that file when new tools are added there.
 */

// ─── Allowed read-only homelab MCP tools ─────────────────────────────────────

const HOMELAB_READ_TOOLS = [
  // Recipes
  "list_boxes",
  "search_recipes",
  "get_recipe",
  "list_cooking_log",
  // Shopping
  "list_shopping_lists",
  "list_shopping_items",
  // Tasks
  "list_task_lists",
  "list_tasks",
  // Travel
  "list_travel_trips",
  "get_travel_trip",
  "get_travel_activity",
  "search_travel",
  "get_trip_issues",
  "list_travel_notes",
  // Life
  "list_life_entries",
  "list_life_trackables",
  // Chat (read)
  "list_chat_messages",
  // Sharing (read)
  "list_invites",
  // Money (all read-only by design — no writes are exposed)
  "list_money_accounts",
  "list_money_balances",
  "list_money_transactions",
  "get_money_net_worth_summary",
  "get_money_net_worth_history",
  "get_money_performance",
  "get_money_spending_summary",
  "list_money_holdings",
  "get_money_allocation",
  "list_money_recurring",
  "list_money_institutions",
  "list_money_people",
  // Observer (read — write is not exposed here; the coach doesn't write
  // observations itself, the observer cron does)
  "generate_observation",
];

// ─── Allowed write tools (additive, low blast radius) ────────────────────────

const HOMELAB_WRITE_TOOLS = [
  "add_life_entry",
  "add_task",
  "add_travel_note",
  "post_chat_message",
];

// ─── Built-in Claude Code tools ──────────────────────────────────────────────

const BUILTIN_TOOLS = [
  // Hosted web search — exposed in the SDK as the `WebSearch` tool. (The
  // separate `{type: "web_search_20250305"}` hosted-tool spec applies to
  // raw Messages API calls, not Agent SDK turns.) Tracked here so the agent
  // can browse for facts the homelab MCP doesn't cover (news, weather,
  // recipes from external sites, etc.).
  "WebSearch",
  "WebFetch",
];

/**
 * Restricted built-in tool surface — passed to the SDK's `tools` option,
 * which is the option that actually limits what the model SEES (sdk.d.ts
 * ~1378). Without this the model gets the full claude_code preset
 * (Bash/Read/Write/Edit/Grep/Glob/…) in its context and burns tokens
 * trying calls that `canUseTool` then denies. MCP tools (`mcp__homelab__*`)
 * are NOT listed here — they come via `mcpServers` and aren't part of the
 * built-in surface.
 */
export const BUILTIN_TOOL_SURFACE: string[] = [...BUILTIN_TOOLS];

/** Full list passed to the SDK's `allowedTools` option (auto-approve, no UI prompt). */
export const ALLOWED_TOOLS: string[] = [
  ...HOMELAB_READ_TOOLS.map((t) => `mcp__homelab__${t}`),
  ...HOMELAB_WRITE_TOOLS.map((t) => `mcp__homelab__${t}`),
  ...BUILTIN_TOOLS,
];

/**
 * Tool name prefixes that are NEVER allowed — destructive operations on
 * the homelab MCP. Passed to the SDK's `disallowedTools` (which the docs
 * say "remove from the model's context") AND enforced in `canUseTool`
 * (per-call belt-and-suspenders).
 */
const FORBIDDEN_PREFIXES = [
  "mcp__homelab__delete_",
  "mcp__homelab__remove_",
  "mcp__homelab__clear_",
];

/**
 * `disallowedTools` list. The SDK accepts exact names here; we expand the
 * common destructive verbs by listing each one. This is the curated
 * counterpart to `FORBIDDEN_PREFIXES` (which is the safety net in
 * `canUseTool`).
 */
export const DISALLOWED_TOOLS: string[] = [
  // Cross-domain destructive ops — match every tool in mcp.ts whose name
  // starts with `delete_`, `remove_`, or `clear_`. List explicitly because
  // glob support in this option is unproven in 0.3.168.
  "mcp__homelab__delete_shopping_list",
  "mcp__homelab__remove_shopping_item",
  "mcp__homelab__clear_checked_items",
  "mcp__homelab__delete_task",
  "mcp__homelab__clear_done_tasks",
  "mcp__homelab__delete_recipe",
  "mcp__homelab__delete_recipe_box",
  "mcp__homelab__delete_cooking_log_entry",
  "mcp__homelab__remove_recipe_ingredient",
  "mcp__homelab__remove_recipe_step",
  "mcp__homelab__delete_travel_trip",
  "mcp__homelab__delete_travel_activity",
  "mcp__homelab__delete_travel_itinerary",
  "mcp__homelab__delete_travel_note",
  "mcp__homelab__remove_itinerary_slot",
  "mcp__homelab__remove_itinerary_flight",
  "mcp__homelab__remove_itinerary_day",
  "mcp__homelab__delete_life_entry",
  "mcp__homelab__remove_life_trackable",
  "mcp__homelab__remove_life_pin",
  "mcp__homelab__delete_invite",
];

/**
 * Defense-in-depth check used by the SDK's `canUseTool` hook. Default-deny:
 * a tool is allowed only if it's in `ALLOWED_TOOLS` AND does not start with
 * a destructive prefix. We re-check the destructive prefix here even
 * though `DISALLOWED_TOOLS` already covers it, because a tool added to
 * `services/api/src/mcp.ts` post-deploy could slip into the curated
 * allowlist via copy-paste with a destructive verb.
 */
export function isToolAllowed(toolName: string): boolean {
  if (FORBIDDEN_PREFIXES.some((p) => toolName.startsWith(p))) return false;
  return ALLOWED_TOOLS.includes(toolName);
}
