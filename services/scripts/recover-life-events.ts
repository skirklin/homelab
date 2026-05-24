/**
 * Recover life_events damaged by the 20260522_221157 life_event_unified_shape
 * migration.
 *
 * Background
 * ----------
 * That migration assumed `record.get("data")` returned a parsed object, but
 * goja exposes PB's []byte JSON columns as JS byte arrays. The defensive
 * `JSON.parse(JSON.stringify(...))` round-trip then turned the bytes into a
 * JS array of numbers — every per-subject mapping branch then operated on
 * the wrong shape. The on-disk damage that survived:
 *
 *   1. Sessions (morning_session / evening_session / weekly_review_session)
 *      ran the catch-all `for (k in data)` loop. Each UTF-8 byte became an
 *      entry: `{ name: "<index>", type: "number", value: <byteCode>, unit: "ct" }`.
 *      Concatenating value-as-charCode for those entries reconstructs the
 *      original JSON exactly — these rows are FULLY RECOVERABLE without the
 *      backup.
 *
 *   2. Composites (sleep, exercise, symptoms, work, mood, content) ran
 *      typed accessors (pickNumber/pickString) against the byte-array, all
 *      of which returned undefined. Those rows now have `entries: []` and
 *      the original `data` blob was cleared. Only the pre-migration backup
 *      can restore them. Rows created AFTER the backup are unrecoverable.
 *
 *   3. Counter / dose / journal / __sample__ branches emitted fixed-shape
 *      entries regardless of `data` content (count=1, default dose, fan-out
 *      by enumeration). Those rows are already correct; we leave them alone.
 *      (Note: __sample__ rows were DELETED outright because the fan-out
 *      filter `typeof v !== "number"` rejected every byte-array key. Those
 *      are unrecoverable here — see "follow-ups" in the report.)
 *
 * Usage
 * -----
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm tsx recover-life-events.ts <backup-data.db> [--user-email <email>] [--dry-run | --apply]
 *
 *   <backup-data.db> = absolute path to the extracted backup sqlite (e.g.
 *                      /tmp/pb-backup-extracted/data.db).
 *   --user-email     = defaults to scott.kirklin@gmail.com
 *   --dry-run        = default; prints what would change.
 *   --apply          = PATCH the rows for real.
 *
 * The script PATCHes existing rows in place (preserving id + timestamp +
 * subject_id). It never inserts or deletes.
 */
import Database from "better-sqlite3";
import { statSync } from "node:fs";
import PocketBase from "pocketbase";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function takeOpt(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const val = argv[i + 1];
  argv.splice(i, 2);
  return val;
}

function takeFlag(name: string): boolean {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}

const userEmail = takeOpt("--user-email") || "scott.kirklin@gmail.com";
const apply = takeFlag("--apply");
const dryRun = takeFlag("--dry-run") || !apply;
const pbUrl = takeOpt("--pb-url") || process.env.PB_URL || `https://api.${process.env.DOMAIN || "kirkl.in"}`;

const positional = argv.filter((a) => !a.startsWith("--"));
const backupPath = positional[0];
if (!backupPath) {
  console.error("Usage: pnpm tsx recover-life-events.ts <backup-data.db> [--user-email <email>] [--dry-run | --apply]");
  process.exit(1);
}
try {
  const st = statSync(backupPath);
  if (!st.isFile()) {
    console.error(`Backup path is not a file: ${backupPath}`);
    process.exit(1);
  }
} catch (err: any) {
  console.error(`Backup not readable: ${backupPath}: ${err.message}`);
  process.exit(1);
}

console.log("==============================================");
console.log("  life_events recovery");
console.log("==============================================");
console.log(`  PB URL:     ${pbUrl}`);
console.log(`  User:       ${userEmail}`);
console.log(`  Backup:     ${backupPath}`);
console.log(`  Mode:       ${dryRun ? "DRY-RUN" : "APPLY"}`);
console.log("");

// ---------------------------------------------------------------------------
// Shape types
// ---------------------------------------------------------------------------

type Entry =
  | { name: string; type: "number"; value: number; unit: string; scale?: number }
  | { name: string; type: "text"; value: string };

interface BackupRow {
  id: string;
  subject_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface CurrentRow {
  id: string;
  subject_id: string;
  timestamp: string;
  entries: Entry[] | null | undefined;
  labels: Record<string, string> | null | undefined;
}

// Subjects we will attempt to recover. (Counter/dose/journal already correct.)
const COMPOSITE_SUBJECTS = new Set<string>([
  "sleep", "exercise", "symptoms", "work", "mood", "content",
]);
const SESSION_SUBJECTS = new Set<string>([
  "morning_session", "evening_session", "weekly_review_session",
]);

const SESSION_PROMPT_TYPES: Record<string, Record<string, "text" | "rating" | "number" | "checkbox">> = {
  morning_session: { gratitude: "text", intention: "text", energy: "rating" },
  evening_session: { win: "text", lesson: "text", mood: "rating" },
  weekly_review_session: { highlights: "text", lows: "text", lesson: "text", intention: "text", mood_rating: "rating" },
};

const RATING_SINGLETONS = new Set<string>(["mood", "content", "sleep_quality", "energy"]);

// ---------------------------------------------------------------------------
// Source -> unified shape (inlined to match the original migration's intent,
// applied to PROPERLY-parsed data this time).
// ---------------------------------------------------------------------------

function pickNumber(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" ? v : undefined;
}
function pickString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function mapComposite(subjectId: string, data: Record<string, unknown>): { entries: Entry[]; labels: Record<string, string> } {
  const entries: Entry[] = [];
  const labels: Record<string, string> = {};
  labels.source = pickString(data, "source") || "manual";

  if (subjectId === "sleep") {
    const hours = pickNumber(data, "hours");
    const value = pickNumber(data, "value");
    if (hours !== undefined) {
      entries.push({ name: "duration", type: "number", value: Math.round(hours * 60), unit: "min" });
    } else if (value !== undefined) {
      entries.push({ name: "duration", type: "number", value, unit: "min" });
    }
    const quality = pickNumber(data, "quality");
    if (quality !== undefined) {
      entries.push({ name: "quality", type: "number", value: quality, unit: "rating", scale: 5 });
    }
    const notes = pickString(data, "notes");
    if (notes) entries.push({ name: "notes", type: "text", value: notes });
  } else if (subjectId === "exercise") {
    const hours = pickNumber(data, "hours");
    const value = pickNumber(data, "value");
    if (hours !== undefined) {
      entries.push({ name: "duration", type: "number", value: Math.round(hours * 60), unit: "min" });
    } else if (value !== undefined) {
      entries.push({ name: "duration", type: "number", value, unit: "min" });
    }
    const intensity = pickNumber(data, "intensity");
    if (intensity !== undefined) {
      entries.push({ name: "intensity", type: "number", value: intensity, unit: "rating", scale: 5 });
    }
    const category = pickString(data, "category");
    if (category) labels.category = category;
    const notes = pickString(data, "notes");
    if (notes) entries.push({ name: "notes", type: "text", value: notes });
  } else if (subjectId === "work") {
    const hours = pickNumber(data, "hours");
    if (hours !== undefined) {
      entries.push({ name: "duration", type: "number", value: Math.round(hours * 60), unit: "min" });
    }
    const quality = pickNumber(data, "quality");
    if (quality !== undefined) {
      entries.push({ name: "quality", type: "number", value: quality, unit: "rating", scale: 5 });
    }
  } else if (subjectId === "symptoms") {
    for (const k of Object.keys(data)) {
      if (k === "notes" || k === "source") continue;
      const v = data[k];
      if (typeof v === "number") {
        entries.push({ name: k, type: "number", value: v, unit: "rating", scale: 5 });
      }
    }
    const notes = pickString(data, "notes");
    if (notes) entries.push({ name: "notes", type: "text", value: notes });
  } else if (RATING_SINGLETONS.has(subjectId)) {
    // mood / content / sleep_quality / energy
    const value = pickNumber(data, "value");
    if (value !== undefined) {
      entries.push({ name: "rating", type: "number", value, unit: "rating", scale: 5 });
    }
    const notes = pickString(data, "notes");
    if (notes) entries.push({ name: "notes", type: "text", value: notes });
  }

  return { entries, labels };
}

function mapSession(subjectId: string, data: Record<string, unknown>): { entries: Entry[]; labels: Record<string, string> } {
  const entries: Entry[] = [];
  const labels: Record<string, string> = { source: pickString(data, "source") || "manual" };
  const promptMap = SESSION_PROMPT_TYPES[subjectId] || {};

  for (const promptId of Object.keys(promptMap)) {
    const v = data[promptId];
    const ptype = promptMap[promptId];
    if (v === undefined || v === null || v === "") continue;
    if (ptype === "text" && typeof v === "string") {
      entries.push({ name: promptId, type: "text", value: v });
    } else if (ptype === "rating" && typeof v === "number") {
      entries.push({ name: promptId, type: "number", value: v, unit: "rating", scale: 5 });
    } else if (ptype === "number" && typeof v === "number") {
      entries.push({ name: promptId, type: "number", value: v, unit: "ct" });
    } else if (ptype === "checkbox") {
      entries.push({ name: promptId, type: "number", value: v ? 1 : 0, unit: "ct" });
    }
  }
  // Catch any unknown extra fields as text — better than dropping them.
  for (const k of Object.keys(data)) {
    if (promptMap[k] !== undefined) continue;
    if (k === "source" || k === "notes") continue;
    const v = data[k];
    if (typeof v === "string") {
      entries.push({ name: k, type: "text", value: v });
    } else if (typeof v === "number") {
      entries.push({ name: k, type: "number", value: v, unit: "ct" });
    }
  }
  const notes = pickString(data, "notes");
  if (notes) entries.push({ name: "notes", type: "text", value: notes });
  return { entries, labels };
}

// ---------------------------------------------------------------------------
// Damage detection
// ---------------------------------------------------------------------------

/**
 * A "corrupted-session" row has at least one entry whose name is the literal
 * string "0" (the first byte index of the JSON blob). Healthy session rows
 * use prompt-id names (gratitude/intention/win/lesson/mood/...).
 */
function isCorruptedSession(row: CurrentRow): boolean {
  if (!SESSION_SUBJECTS.has(row.subject_id)) return false;
  const entries = row.entries || [];
  if (entries.length === 0) return false;
  return entries.some((e) => e.name === "0");
}

/** Decode a corrupted-session row's entries (each value = one UTF-8 byte). */
function decodeSessionBytes(entries: Entry[]): string {
  let s = "";
  for (const e of entries) {
    if (e.type !== "number") continue;
    s += String.fromCharCode(e.value);
  }
  return s;
}

/**
 * A "lost-composite" row has subject_id in COMPOSITE_SUBJECTS and
 * entries.length === 0 (the migration cleared the data column and produced
 * no entries).
 */
function isLostComposite(row: CurrentRow): boolean {
  if (!COMPOSITE_SUBJECTS.has(row.subject_id)) return false;
  return (row.entries || []).length === 0;
}

// ---------------------------------------------------------------------------
// Auth + resolve owner / log
// ---------------------------------------------------------------------------

const password = process.env.PB_ADMIN_PASSWORD;
if (!password) {
  console.error("PB_ADMIN_PASSWORD not set");
  process.exit(1);
}

const pb = new PocketBase(pbUrl);
pb.autoCancellation(false);

try {
  await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);
} catch (err: any) {
  console.error(`PB auth failed: ${err.message}`);
  process.exit(1);
}
console.log("  PB auth OK");

const userRec = await pb.collection("users").getFirstListItem(
  pb.filter("email = {:email}", { email: userEmail }),
  { $autoCancel: false },
).catch(() => null);
if (!userRec) {
  console.error(`User not found: ${userEmail}`);
  process.exit(1);
}
const userId = userRec.id;

const logRec = await pb.collection("life_logs").getFirstListItem(
  pb.filter("owner = {:uid}", { uid: userId }),
  { $autoCancel: false },
).catch(() => null);
if (!logRec) {
  console.error(`No life_log for ${userEmail}`);
  process.exit(1);
}
const logId = logRec.id;
console.log(`  User:       ${userId}`);
console.log(`  Life log:   ${logId}`);

// ---------------------------------------------------------------------------
// Load backup
// ---------------------------------------------------------------------------

// Resolve which backup log_id(s) belong to this user. The current life_logs
// schema is single-`owner`; the backup may use `owners` (JSON array) per
// migration 0028. Match by either.
const db = new Database(backupPath, { readonly: true, fileMustExist: true });
const allBackupLogs = db.prepare(
  "SELECT id, owners FROM life_logs",
).all() as Array<{ id: string; owners: string | null }>;
const backupLogIds: string[] = [];
for (const r of allBackupLogs) {
  if (!r.owners) continue;
  try {
    const arr = JSON.parse(r.owners) as unknown;
    if (Array.isArray(arr) && arr.includes(userId)) {
      backupLogIds.push(r.id);
    }
  } catch { /* ignore */ }
}
if (backupLogIds.length === 0) {
  console.warn(`  WARN: no backup life_log found owned by ${userId}; no composite recovery possible.`);
} else {
  console.log(`  Backup log ids for user: ${backupLogIds.join(", ")}`);
}

// Note: the backup's life_log id will NOT match the current life_log id —
// the log record was re-created at some point. We match by
// (subject_id, timestamp) within this user's events. Record ids therefore
// drift; we rely on subject_id + timestamp uniqueness, which is consistent
// for one human's events (no script writes two events at the same ms).
const backupQuery = backupLogIds.length === 0
  ? db.prepare("SELECT id, subject_id, timestamp, data FROM life_events WHERE 1=0")
  : db.prepare(
      `SELECT id, subject_id, timestamp, data FROM life_events WHERE log IN (${backupLogIds.map(() => "?").join(",")})`,
    );
const backupRows = backupQuery.all(...backupLogIds) as Array<{ id: string; subject_id: string; timestamp: string; data: string | null }>;

const backupByKey = new Map<string, BackupRow>();
let backupDupes = 0;
for (const r of backupRows) {
  let parsed: Record<string, unknown> = {};
  if (r.data && typeof r.data === "string") {
    try { parsed = JSON.parse(r.data) as Record<string, unknown>; } catch { parsed = {}; }
  }
  const key = `${r.subject_id}|${r.timestamp}`;
  if (backupByKey.has(key)) {
    backupDupes++;
  }
  backupByKey.set(key, {
    id: r.id,
    subject_id: r.subject_id,
    timestamp: r.timestamp,
    data: parsed,
  });
}
db.close();
console.log(`  Backup rows (this user): ${backupRows.length} (${backupDupes} (subject,ts) dupes — last wins)`);

// ---------------------------------------------------------------------------
// Walk current life_events
// ---------------------------------------------------------------------------

const current = await pb.collection("life_events").getFullList({
  filter: pb.filter("log = {:logId}", { logId }),
  $autoCancel: false,
});
console.log(`  Current rows:           ${current.length}`);
console.log("");

interface Plan {
  id: string;
  subject_id: string;
  timestamp: string;
  reason: "session-decoded" | "composite-from-backup";
  next: { entries: Entry[]; labels: Record<string, string> };
  before: { entries: Entry[]; labels: Record<string, string> | null };
}

const plans: Plan[] = [];
let sessionsCorrupted = 0;
let sessionsDecodedOK = 0;
let sessionsDecodeFailed = 0;
let compositesEmpty = 0;
let compositesFromBackup = 0;
let compositesLostNoBackup = 0;
let countersSkipped = 0;
let healthySessionsSkipped = 0;
let otherSkipped = 0;

for (const raw of current) {
  const row: CurrentRow = {
    id: raw.id as string,
    subject_id: (raw.subject_id as string) || "",
    timestamp: raw.timestamp as string,
    entries: raw.entries as Entry[] | null | undefined,
    labels: raw.labels as Record<string, string> | null | undefined,
  };
  const before = {
    entries: (row.entries || []) as Entry[],
    labels: (row.labels ?? null) as Record<string, string> | null,
  };

  if (isCorruptedSession(row)) {
    sessionsCorrupted++;
    const blob = decodeSessionBytes(row.entries as Entry[]);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(blob) as Record<string, unknown>;
    } catch {
      sessionsDecodeFailed++;
      continue;
    }
    sessionsDecodedOK++;
    const mapped = mapSession(row.subject_id, parsed);
    plans.push({
      id: row.id,
      subject_id: row.subject_id,
      timestamp: row.timestamp,
      reason: "session-decoded",
      next: mapped,
      before,
    });
    continue;
  }

  if (isLostComposite(row)) {
    compositesEmpty++;
    const b = backupByKey.get(`${row.subject_id}|${row.timestamp}`);
    if (!b) {
      compositesLostNoBackup++;
      continue;
    }
    const mapped = mapComposite(row.subject_id, b.data);
    if (mapped.entries.length === 0) {
      // Backup row exists but had no usable numeric fields; nothing to write.
      compositesLostNoBackup++;
      continue;
    }
    compositesFromBackup++;
    plans.push({
      id: row.id,
      subject_id: row.subject_id,
      timestamp: row.timestamp,
      reason: "composite-from-backup",
      next: mapped,
      before,
    });
    continue;
  }

  // Healthy / out-of-scope rows.
  if (SESSION_SUBJECTS.has(row.subject_id)) {
    healthySessionsSkipped++;
  } else if (COMPOSITE_SUBJECTS.has(row.subject_id)) {
    // Composite with non-empty entries — already correct (or already touched).
    countersSkipped++;
  } else {
    otherSkipped++;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("  ---------- Summary ----------");
console.log(`  Rows scanned:                     ${current.length}`);
console.log(`  Sessions w/ corrupted entries:    ${sessionsCorrupted}`);
console.log(`    -> decoded + remapped:          ${sessionsDecodedOK}`);
console.log(`    -> decode failed (kept as-is):  ${sessionsDecodeFailed}`);
console.log(`  Composite rows with empty entries:${compositesEmpty}`);
console.log(`    -> restored from backup:        ${compositesFromBackup}`);
console.log(`    -> lost (no backup row):        ${compositesLostNoBackup}`);
console.log(`  Healthy sessions (skipped):       ${healthySessionsSkipped}`);
console.log(`  Healthy composites (skipped):     ${countersSkipped}`);
console.log(`  Other rows (skipped):             ${otherSkipped}`);
console.log(`  Total PATCHes planned:            ${plans.length}`);

if (plans.length > 0) {
  console.log("");
  console.log("  ---------- Sample plans ----------");
  // First session-decoded, first composite, plus the last of each kind if different.
  const seenReasons = new Set<string>();
  const picks: Plan[] = [];
  for (const p of plans) {
    const key = `${p.reason}:first`;
    if (!seenReasons.has(key)) {
      seenReasons.add(key);
      picks.push(p);
    }
  }
  for (const p of plans.slice().reverse()) {
    const key = `${p.reason}:last`;
    if (!seenReasons.has(key)) {
      seenReasons.add(key);
      picks.push(p);
    }
  }
  for (const p of picks.slice(0, 6)) {
    console.log("");
    console.log(`  [${p.reason}]  id=${p.id}  subject=${p.subject_id}  ts=${p.timestamp}`);
    console.log(`    BEFORE: entries=${JSON.stringify(p.before.entries).slice(0, 200)}${JSON.stringify(p.before.entries).length > 200 ? "..." : ""}`);
    console.log(`            labels=${JSON.stringify(p.before.labels)}`);
    console.log(`    AFTER:  entries=${JSON.stringify(p.next.entries).slice(0, 200)}${JSON.stringify(p.next.entries).length > 200 ? "..." : ""}`);
    console.log(`            labels=${JSON.stringify(p.next.labels)}`);
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log("");
  console.log("  Dry run: no changes written. Pass --apply to commit.");
  process.exit(0);
}

console.log("");
console.log(`  Applying ${plans.length} PATCHes...`);
let patched = 0;
let errors = 0;
for (const p of plans) {
  try {
    await pb.collection("life_events").update(p.id, {
      entries: p.next.entries,
      labels: Object.keys(p.next.labels).length > 0 ? p.next.labels : null,
    }, { $autoCancel: false });
    patched++;
    if (patched % 25 === 0) console.log(`    ...${patched}/${plans.length}`);
  } catch (err: any) {
    errors++;
    console.error(`    ERROR ${p.id}: ${err.message}`);
  }
}
console.log("");
console.log(`  Patched: ${patched}  Errors: ${errors}`);
process.exit(errors > 0 ? 1 : 0);
