#!/usr/bin/env tsx
/**
 * Homelab admin CLI — small wrapper around common PocketBase/k8s operations
 * so we don't have to write giant curl commands everywhere.
 *
 * Usage:
 *   tools/admin <command> [args]
 *
 * Commands:
 *   collections                   List all custom collections + field summary
 *   schema <collection>           Show full schema for one collection
 *   query <collection> [filter]   List records (use '*' for no filter)
 *   get <collection> <id>         Get one record (raw JSON)
 *   count <collection> [filter]   Count records matching filter
 *   users                         List all users with IDs and emails
 *   audit-timestamps              Find collections missing created/updated
 *   pods                          List homelab pods (via SSH)
 *   logs <pod-or-deployment> [n]  Tail logs via SSH (default 20 lines)
 *
 * Auth: reads PB_ADMIN_PASSWORD and HOMELAB_API_TOKEN from env (source .env).
 * PB URL: PB_URL env var or https://api.${DOMAIN:-kirkl.in}.
 */
import PocketBase from "pocketbase";
import { execSync } from "child_process";

const PB_URL = process.env.PB_URL || `https://api.${process.env.DOMAIN || "kirkl.in"}`;
const ADMIN_EMAIL = "scott.kirklin@gmail.com";
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;

let pb: PocketBase | null = null;

async function getPb() {
  if (pb) return pb;
  if (!ADMIN_PASSWORD) {
    die("PB_ADMIN_PASSWORD not set. Run: set -a && source .env && set +a");
  }
  const client = new PocketBase(PB_URL);
  client.autoCancellation(false);
  await client.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  pb = client;
  return client;
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function fmtJson(x: unknown): string {
  return JSON.stringify(x, null, 2);
}

function ssh(cmd: string): string {
  const vps = process.env.HOMELAB_VPS || "scott@5.78.200.161";
  return execSync(`ssh ${vps} ${JSON.stringify(cmd)}`, { encoding: "utf8" });
}

// --- commands ---

async function collections() {
  const client = await getPb();
  const res = await client.collections.getFullList();
  const custom = res.filter((c) => c.type === "base" && !c.system);
  const rows = custom.map((c) => {
    const fields = c.fields || [];
    const hasCreated = fields.some((f) => f.name === "created");
    const hasUpdated = fields.some((f) => f.name === "updated");
    return {
      name: c.name,
      fields: fields.length,
      timestamps: hasCreated && hasUpdated ? "✓" : "✗",
    };
  });
  console.table(rows);
}

async function schema(name: string) {
  if (!name) die("Usage: admin schema <collection>");
  const client = await getPb();
  const col = await client.collections.getOne(name);
  console.log(fmtJson({
    name: col.name,
    type: col.type,
    listRule: col.listRule,
    viewRule: col.viewRule,
    createRule: col.createRule,
    updateRule: col.updateRule,
    deleteRule: col.deleteRule,
    fields: col.fields,
    indexes: col.indexes,
  }));
}

async function query(name: string, filter?: string) {
  if (!name) die("Usage: admin query <collection> [filter]");
  const client = await getPb();
  const opts: Record<string, unknown> = { $autoCancel: false };
  if (filter && filter !== "*") opts.filter = filter;
  const records = await client.collection(name).getFullList(opts);
  console.log(fmtJson(records));
}

async function count(name: string, filter?: string) {
  if (!name) die("Usage: admin count <collection> [filter]");
  const client = await getPb();
  const opts: Record<string, unknown> = { perPage: 1 };
  if (filter && filter !== "*") opts.filter = filter;
  const res = await client.collection(name).getList(1, 1, opts);
  console.log(res.totalItems);
}

async function get(name: string, id: string) {
  if (!name || !id) die("Usage: admin get <collection> <id>");
  const client = await getPb();
  const record = await client.collection(name).getOne(id);
  console.log(fmtJson(record));
}

async function users() {
  const client = await getPb();
  const res = await client.collection("users").getFullList();
  const rows = res.map((u) => ({ id: u.id, email: u.email, name: u.name || "" }));
  console.table(rows);
}

async function auditTimestamps() {
  const client = await getPb();
  const cols = await client.collections.getFullList();
  const custom = cols.filter((c) => c.type === "base" && !c.system);
  const missing: string[] = [];
  for (const c of custom) {
    const names = new Set((c.fields || []).map((f) => f.name));
    if (!names.has("created") || !names.has("updated")) missing.push(c.name);
  }
  if (missing.length === 0) {
    console.log("All custom collections have created/updated ✓");
  } else {
    console.log(`${missing.length} collection(s) missing timestamps:`);
    for (const n of missing) console.log(`  - ${n}`);
  }
}

function pods() {
  const out = ssh("kubectl get pods -n homelab");
  console.log(out);
}

function logs(target: string, n: string = "20") {
  if (!target) die("Usage: admin logs <pod-or-deployment> [n]");
  // Accept 'pocketbase' and try statefulset/pod/deployment in that order.
  const candidates = target.includes("/")
    ? [target]
    : [`statefulset/${target}`, `deployment/${target}`, `pod/${target}`, target];
  for (const c of candidates) {
    try {
      const out = ssh(`kubectl logs -n homelab ${c} --tail=${n} 2>/dev/null`);
      if (out.trim()) {
        console.log(out);
        return;
      }
    } catch {
      // try next
    }
  }
  // Final try without suppression so user sees the error
  try {
    console.log(ssh(`kubectl logs -n homelab ${target} --tail=${n}`));
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

// --- dispatch ---

const [cmd, ...args] = process.argv.slice(2);

const commands: Record<string, (...args: string[]) => unknown> = {
  collections,
  schema,
  query,
  count,
  get,
  users,
  "audit-timestamps": auditTimestamps,
  pods,
  logs,
};

if (!cmd || !(cmd in commands)) {
  console.error("Usage: admin <command> [args]");
  console.error("Commands: " + Object.keys(commands).join(", "));
  process.exit(1);
}

Promise.resolve(commands[cmd](...args))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
