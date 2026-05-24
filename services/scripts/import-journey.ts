/**
 * Import Journey app journal entries into PocketBase `life_events`.
 *
 * Journey's native export is a zip of `<timestamp>-<id>.json` files, one
 * entry per file. Photos are explicitly dropped — not migrated.
 *
 * Writes the unified life_events shape (post-20260522 migration):
 *   subject_id: "journal"
 *   entries: [
 *     { name: "body", type: "text", value: <plain-text> },
 *     { name: "mood", type: "number", value: <1-5>, unit: "rating", scale: 5 } | absent,
 *   ]
 *   labels: { source: "journey", journey_id, tz?, weather?, location_*?, ... }
 *
 * Usage:
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm tsx import-journey.ts <zip-or-dir> [...] [--dry-run|--apply] [--user-email <email>]
 *
 * Default is --dry-run. --apply commits.
 *
 * Idempotency: deduped by labels.journey_id against the user's existing
 * `journal` (and legacy `freeform_journal`) events. Safe to re-run.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const paths = argv.filter((a) => !a.startsWith("--"));
if (paths.length === 0) {
  console.error("Usage: pnpm tsx import-journey.ts <zip-or-dir> [...] [--dry-run|--apply] [--user-email <email>]");
  process.exit(1);
}

console.log("==============================================");
console.log("  Journey -> PocketBase Import");
console.log("==============================================");
console.log(`  PB URL:     ${pbUrl}`);
console.log(`  User:       ${userEmail}`);
console.log(`  Mode:       ${dryRun ? "DRY-RUN" : "APPLY"}`);
console.log(`  Inputs:     ${paths.length} path(s)`);
console.log("");

// ---------------------------------------------------------------------------
// Journey types + parsing
// ---------------------------------------------------------------------------

// Journey serializes "not set" for floats as Java's Double.MAX_VALUE
// (1.7976931348623157e+308). Anything within ~10 orders of magnitude of that
// is treated as missing.
const SENTINEL_THRESHOLD = 1e300;

interface JourneyEntry {
  id: string;
  date_modified: number;
  date_journal: number;
  timezone?: string;
  text?: string;
  preview_text?: string;
  mood?: number;
  lat?: number;
  lon?: number;
  address?: string;
  label?: string;
  folder?: string;
  sentiment?: number;
  favourite?: boolean;
  music_title?: string;
  music_artist?: string;
  photos?: unknown[];
  weather?: { id?: number; degree_c?: number; description?: string; icon?: string; place?: string };
  tags?: string[];
  type?: string;
}

type LifeEntryWire =
  | { name: string; type: "number"; value: number; unit: string; scale?: number }
  | { name: string; type: "text"; value: string };

interface MappedEntry {
  source_path: string;
  journey_id: string;
  timestamp: string;
  entries: LifeEntryWire[];
  labels: Record<string, string>;
  /** Plain-text body — surfaced for dry-run sample previews. */
  bodyText: string;
  /** Mood 1..5, or undefined when absent. Surfaced for stats. */
  mood?: number;
  /** Lat/lon pulled for stats only; canonical storage is labels.location_*. */
  loc?: { lat: number; lon: number; address?: string };
  /** Tags pulled for stats only; canonical storage is labels.tags (comma-joined). */
  tags?: string[];
  /** Weather pulled for stats only. */
  weatherDescription?: string;
  /** Music pulled for stats only. */
  music?: { title?: string; artist?: string };
  favourite?: boolean;
}

/**
 * Strip Journey's `type: "html"` body to plain text. Journey wraps every
 * paragraph in `<p dir="auto">` and uses `<br>` for soft breaks; everything
 * else (lists, formatting) is rare but we handle the common cases. Empty
 * `<p></p>` from Journey separates paragraphs — convert those to blank lines.
 */
function stripHtml(html: string | undefined): string {
  if (!html) return "";
  let s = html;
  // List items as bullet lines before paragraph normalization.
  s = s.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<\/(?:ul|ol)>/gi, "\n");
  // Paragraph + line breaks → newlines.
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<p[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, "");
  // HTML entity decode for the common ones — Journey only emits a handful.
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  // Trim each line, then collapse 3+ blank lines to 2.
  s = s.split("\n").map((l) => l.trimEnd()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function mapEntry(entry: JourneyEntry, sourcePath: string): MappedEntry {
  const entries: LifeEntryWire[] = [];
  const labels: Record<string, string> = {
    source: "journey",
    journey_id: entry.id,
  };

  const text = stripHtml(entry.text);
  if (text) entries.push({ name: "body", type: "text", value: text });
  // Preserve the original HTML body as a separate text entry — useful for
  // future re-renderers / forensic debugging without bloating the labels.
  if (entry.text) entries.push({ name: "body_html", type: "text", value: entry.text });

  let mood: number | undefined;
  if (typeof entry.mood === "number" && entry.mood > 0) {
    mood = entry.mood;
    entries.push({ name: "mood", type: "number", value: mood, unit: "rating", scale: 5 });
  }

  let loc: { lat: number; lon: number; address?: string } | undefined;
  if (
    typeof entry.lat === "number" && typeof entry.lon === "number" &&
    entry.lat < SENTINEL_THRESHOLD && entry.lon < SENTINEL_THRESHOLD
  ) {
    loc = { lat: entry.lat, lon: entry.lon };
    if (entry.address) loc.address = entry.address;
    labels.location_lat = String(entry.lat);
    labels.location_lon = String(entry.lon);
    if (entry.address) labels.location_address = entry.address;
  }

  let tagsCopy: string[] | undefined;
  if (entry.tags && entry.tags.length > 0) {
    tagsCopy = entry.tags.filter((t): t is string => typeof t === "string");
    if (tagsCopy.length > 0) labels.tags = tagsCopy.join(",");
  }

  let weatherDescription: string | undefined;
  if (
    entry.weather &&
    typeof entry.weather.degree_c === "number" &&
    entry.weather.degree_c < SENTINEL_THRESHOLD &&
    entry.weather.description
  ) {
    weatherDescription = entry.weather.description;
    labels.weather = entry.weather.description;
    labels.weather_degree_c = String(entry.weather.degree_c);
    if (entry.weather.place) labels.weather_place = entry.weather.place;
  }

  if (entry.favourite) labels.favourite = "true";

  let musicCopy: { title?: string; artist?: string } | undefined;
  if (entry.music_title || entry.music_artist) {
    musicCopy = {};
    if (entry.music_title) {
      musicCopy.title = entry.music_title;
      labels.music_title = entry.music_title;
    }
    if (entry.music_artist) {
      musicCopy.artist = entry.music_artist;
      labels.music_artist = entry.music_artist;
    }
  }

  if (entry.timezone) labels.tz = entry.timezone;

  return {
    source_path: sourcePath,
    journey_id: entry.id,
    timestamp: new Date(entry.date_journal).toISOString(),
    entries,
    labels,
    bodyText: text,
    mood,
    loc,
    tags: tagsCopy,
    weatherDescription,
    music: musicCopy,
    favourite: entry.favourite,
  };
}

// ---------------------------------------------------------------------------
// Input ingestion (zips + dirs)
// ---------------------------------------------------------------------------

function isZip(p: string): boolean {
  return p.toLowerCase().endsWith(".zip");
}

/**
 * Read JSON entry files from a directory, dropping photos and any other
 * non-json artifacts Journey occasionally bundles in the export.
 */
function readEntriesFromDir(dir: string): MappedEntry[] {
  const out: MappedEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const full = join(dir, name);
    try {
      const raw = readFileSync(full, "utf-8");
      const entry = JSON.parse(raw) as JourneyEntry;
      if (!entry.id || typeof entry.date_journal !== "number") {
        console.warn(`  skip (malformed): ${name}`);
        continue;
      }
      out.push(mapEntry(entry, full));
    } catch (err: any) {
      console.warn(`  skip (parse error): ${name}: ${err.message}`);
    }
  }
  return out;
}

const tempDirs: string[] = [];

function collectFromPath(p: string): MappedEntry[] {
  const st = statSync(p);
  if (st.isDirectory()) {
    return readEntriesFromDir(p);
  }
  if (st.isFile() && isZip(p)) {
    const tmp = mkdtempSync(join(tmpdir(), "journey-"));
    tempDirs.push(tmp);
    // Shelling out to unzip — simpler than pulling in a zip lib for a one-shot.
    // `-q` quiet, `-o` overwrite, `-j` flatten (no nested dirs in Journey zips,
    // but defensive).
    execSync(`unzip -q -o -j "${p}" -d "${tmp}"`, { stdio: ["ignore", "ignore", "inherit"] });
    return readEntriesFromDir(tmp);
  }
  console.warn(`  skip (not a zip or directory): ${p}`);
  return [];
}

// ---------------------------------------------------------------------------
// Collect + dedupe across inputs
// ---------------------------------------------------------------------------

let allEntries: MappedEntry[] = [];
for (const p of paths) {
  console.log(`  reading: ${p}`);
  const batch = collectFromPath(p);
  console.log(`    ${batch.length} entries`);
  allEntries.push(...batch);
}

// Cross-zip dedupe: keep first occurrence of each journey_id.
const seen = new Set<string>();
const deduped: MappedEntry[] = [];
for (const e of allEntries) {
  if (seen.has(e.journey_id)) continue;
  seen.add(e.journey_id);
  deduped.push(e);
}
const duplicatesAcrossInputs = allEntries.length - deduped.length;
allEntries = deduped;
allEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

console.log("");
console.log(`  Total entries seen:      ${allEntries.length + duplicatesAcrossInputs}`);
console.log(`  Cross-input duplicates:  ${duplicatesAcrossInputs}`);
console.log(`  Unique entries:          ${allEntries.length}`);

// ---------------------------------------------------------------------------
// PB auth + dedupe against existing
// ---------------------------------------------------------------------------

const password = process.env.PB_ADMIN_PASSWORD;
if (!password) {
  console.error("\nPB_ADMIN_PASSWORD not set");
  cleanup();
  process.exit(1);
}

const pb = new PocketBase(pbUrl);
pb.autoCancellation(false);

try {
  await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password);
} catch (err: any) {
  console.error(`\nPB auth failed: ${err.message}`);
  cleanup();
  process.exit(1);
}
console.log("\n  PB auth OK");

// Resolve user by email.
const userRec = await pb.collection("users").getFirstListItem(
  pb.filter("email = {:email}", { email: userEmail }),
  { $autoCancel: false },
).catch(() => null);
if (!userRec) {
  console.error(`\nUser not found: ${userEmail}`);
  cleanup();
  process.exit(1);
}
const userId = userRec.id;

// Resolve user's life log.
const logRec = await pb.collection("life_logs").getFirstListItem(
  pb.filter("owner = {:uid}", { uid: userId }),
  { $autoCancel: false },
).catch(() => null);
if (!logRec) {
  console.error(`\nNo life_log for ${userEmail}. Open the life app once to create one, then re-run.`);
  cleanup();
  process.exit(1);
}
const logId = logRec.id;
console.log(`  User:       ${userId}`);
console.log(`  Life log:   ${logId}`);

// Pull existing journal events for idempotency. Match both the new
// "journal" subject_id and the pre-migration "freeform_journal" id.
// labels.journey_id is the source of truth post-20260522 migration; old rows
// keep journey_id in data — handled below.
const existing = await pb.collection("life_events").getFullList({
  filter: pb.filter(
    "log = {:logId} && (subject_id = {:sidNew} || subject_id = {:sidOld})",
    { logId, sidNew: "journal", sidOld: "freeform_journal" },
  ),
  $autoCancel: false,
});
const existingJourneyIds = new Set<string>();
for (const r of existing) {
  const labels = r.labels as Record<string, string> | undefined;
  const jidFromLabels = labels?.journey_id;
  if (typeof jidFromLabels === "string" && jidFromLabels.length > 0) {
    existingJourneyIds.add(jidFromLabels);
    continue;
  }
  // Pre-migration fallback in case anything escapes the schema migration.
  const data = r.data as Record<string, unknown> | undefined;
  const jidFromData = data?.journey_id;
  if (typeof jidFromData === "string") existingJourneyIds.add(jidFromData);
}
console.log(`  Existing journal events: ${existing.length} (${existingJourneyIds.size} with journey_id)`);

// Partition into new vs already-imported.
const toImport: MappedEntry[] = [];
const skipped: MappedEntry[] = [];
for (const e of allEntries) {
  if (existingJourneyIds.has(e.journey_id)) skipped.push(e);
  else toImport.push(e);
}

// ---------------------------------------------------------------------------
// Stats + sample render
// ---------------------------------------------------------------------------

const stats = {
  withLocation: 0,
  withMood: 0,
  withTags: 0,
  withWeather: 0,
  withMusic: 0,
  emptyText: 0,
};
for (const e of toImport) {
  if (e.loc) stats.withLocation++;
  if (typeof e.mood === "number") stats.withMood++;
  if (e.tags && e.tags.length > 0) stats.withTags++;
  if (e.weatherDescription) stats.withWeather++;
  if (e.music) stats.withMusic++;
  if (!e.bodyText) stats.emptyText++;
}

console.log("");
console.log("  ---------- Counts ----------");
console.log(`  New (would insert):      ${toImport.length}`);
console.log(`  Already imported:        ${skipped.length}`);
console.log(`  With location:           ${stats.withLocation}`);
console.log(`  With mood:               ${stats.withMood}`);
console.log(`  With tags:               ${stats.withTags}`);
console.log(`  With weather:            ${stats.withWeather}`);
console.log(`  With music:              ${stats.withMusic}`);
console.log(`  Empty text:              ${stats.emptyText}`);

if (toImport.length > 0) {
  console.log("");
  console.log("  ---------- Date range (new) ----------");
  console.log(`  First: ${toImport[0].timestamp}`);
  console.log(`  Last:  ${toImport[toImport.length - 1].timestamp}`);

  console.log("");
  console.log("  ---------- Samples ----------");
  // Pick 3 evenly spaced, then nudge to ones with richer data when possible.
  const sampleIdxs = new Set<number>();
  const n = toImport.length;
  if (n >= 1) sampleIdxs.add(0);
  if (n >= 2) sampleIdxs.add(n - 1);
  if (n >= 3) sampleIdxs.add(Math.floor(n / 2));
  // Try to add one with location + mood for variety, if we don't already have it.
  if (sampleIdxs.size < 5) {
    const richIdx = toImport.findIndex((e) => e.loc && typeof e.mood === "number");
    if (richIdx >= 0) sampleIdxs.add(richIdx);
  }
  const sorted = Array.from(sampleIdxs).sort((a, b) => a - b);
  for (const idx of sorted) {
    const e = toImport[idx];
    const preview = e.bodyText.slice(0, 280).replace(/\n+/g, " ⏎ ");
    const more = e.bodyText.length > 280 ? ` … [+${e.bodyText.length - 280} chars]` : "";
    console.log("");
    console.log(`  [#${idx + 1}/${toImport.length}] ${e.timestamp}  (journey_id=${e.journey_id})`);
    const meta: string[] = [];
    if (typeof e.mood === "number") meta.push(`mood=${e.mood}`);
    if (e.tags && e.tags.length > 0) meta.push(`tags=[${e.tags.join(", ")}]`);
    if (e.loc) {
      meta.push(`loc=${e.loc.lat.toFixed(3)},${e.loc.lon.toFixed(3)}${e.loc.address ? ` (${e.loc.address})` : ""}`);
    }
    if (e.weatherDescription) meta.push(`weather=${e.weatherDescription}`);
    if (e.favourite) meta.push("★");
    if (meta.length > 0) console.log(`    ${meta.join("  ")}`);
    console.log(`    text: ${preview}${more}`);
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log("");
  console.log("  Dry run: no changes written. Pass --apply to commit.");
  cleanup();
  process.exit(0);
}

console.log("");
console.log(`  Applying: inserting ${toImport.length} entries...`);

let created = 0, errors = 0;
for (const e of toImport) {
  try {
    await pb.collection("life_events").create({
      log: logId,
      subject_id: "journal",
      timestamp: e.timestamp,
      created_by: userId,
      entries: e.entries,
      labels: e.labels,
    }, { $autoCancel: false });
    created++;
    if (created % 25 === 0) console.log(`    ...${created}/${toImport.length}`);
  } catch (err: any) {
    errors++;
    console.error(`    ERROR ${e.journey_id}: ${err.message}`);
  }
}

console.log("");
console.log(`  Created: ${created}  Errors: ${errors}  Skipped (already had): ${skipped.length}`);
cleanup();
process.exit(errors > 0 ? 1 : 0);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
