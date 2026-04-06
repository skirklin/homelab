/**
 * Migrate all trips from SQLite travel.db to Firestore.
 * Reads trip data, activities, and matches Drive docs where available.
 *
 * Usage: npx tsx scripts/travel/migrate-all.ts [--dry-run]
 */

import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";

admin.initializeApp({ projectId: "recipe-box-335721" });
const db = admin.firestore();

const DRY_RUN = process.argv.includes("--dry-run");
const ARCHIVE = "/home/skirklin/travel-archive";

// We'll use the sqlite3 CLI since better-sqlite3 may not be installed
import { execSync } from "child_process";

function sqlite(query: string): string {
  return execSync(`sqlite3 "${ARCHIVE}/travel.db" "${query}"`, { encoding: "utf8" });
}

function sqliteJson(query: string): Record<string, string>[] {
  const out = execSync(`sqlite3 -json "${ARCHIVE}/travel.db" "${query}"`, { encoding: "utf8" });
  return JSON.parse(out || "[]");
}

function now() { return admin.firestore.Timestamp.now(); }

function toTs(d: Date): admin.firestore.Timestamp {
  return admin.firestore.Timestamp.fromDate(d);
}

// Parse human date ranges like "July 4–15, 2017" or "May 24 – June 1, 2019"
function parseDateRange(s: string): { start: Date | null; end: Date | null } {
  if (!s) return { start: null, end: null };
  const clean = s.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

  // "Month Day-Day, Year"
  let m = clean.match(/^(\w+)\s+(\d+)\s*-\s*(\d+),?\s*(\d{4})$/);
  if (m) return { start: new Date(`${m[1]} ${m[2]}, ${m[4]}`), end: new Date(`${m[1]} ${m[3]}, ${m[4]}`) };

  // "Month Day - Month Day, Year"
  m = clean.match(/^(\w+)\s+(\d+)\s*-\s*(\w+)\s+(\d+),?\s*(\d{4})$/);
  if (m) return { start: new Date(`${m[1]} ${m[2]}, ${m[5]}`), end: new Date(`${m[3]} ${m[4]}, ${m[5]}`) };

  // "Mon Day-Day, Year" (short month)
  m = clean.match(/^(\w{3})\s+(\d+)\s*-\s*(\d+),?\s*(\d{4})$/);
  if (m) return { start: new Date(`${m[1]} ${m[2]}, ${m[4]}`), end: new Date(`${m[1]} ${m[3]}, ${m[4]}`) };

  // "Month-Month Year"
  m = clean.match(/^(\w+)\s*-\s*(\w+)\s+(\d{4})$/);
  if (m) return { start: new Date(`${m[1]} 1, ${m[3]}`), end: new Date(`${m[2]} 28, ${m[3]}`) };

  // "Month Year"
  m = clean.match(/^(\w+)\s+(\d{4})$/);
  if (m) return { start: new Date(`${m[1]} 1, ${m[2]}`), end: null };

  // "Month Day, Year"
  m = clean.match(/^(\w+)\s+(\d+),?\s*(\d{4})$/);
  if (m) { const d = new Date(clean); return { start: d, end: d }; }

  // Fallback: try Date.parse
  const d = new Date(clean);
  if (!isNaN(d.getTime())) return { start: d, end: null };

  return { start: null, end: null };
}

// Parse "Day 1 — Fri May 24: Sedona" → { dayNum, label, location }
function parseDayLoc(loc: string): { dayNum: number; label: string; location: string } | null {
  const m = (loc || "").match(/^Day\s+(\d+)\s*[–—-]\s*(.+?):\s*(.+)$/);
  if (m) return { dayNum: parseInt(m[1]), label: loc, location: m[3].trim() };
  return null;
}

// Read docx via python (returns text or empty string)
function readDocx(filePath: string): string {
  try {
    return execSync(
      `python3 -c "import docx; doc=docx.Document('${filePath.replace(/'/g, "\\'")}'); print('\\n'.join(p.text for p in doc.paragraphs))"`,
      { encoding: "utf8", timeout: 10000 }
    );
  } catch { return ""; }
}

// Find Drive docs that might match a trip destination
function findDriveDocs(destination: string): string[] {
  const results: string[] = [];
  const keywords = destination
    .replace(/[—–+&,]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !["the", "and", "for", "NP", "NPs"].includes(w));

  // Search top-level and Archive
  for (const dir of [ARCHIVE, path.join(ARCHIVE, "Archive"), path.join(ARCHIVE, "Camping")]) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Check if folder name matches
        const folderLower = entry.name.toLowerCase();
        if (keywords.some(k => folderLower.includes(k.toLowerCase()))) {
          // Read all docx in that folder
          const subDir = path.join(dir, entry.name);
          for (const f of fs.readdirSync(subDir)) {
            if (f.endsWith(".docx")) results.push(path.join(subDir, f));
          }
        }
      } else if (entry.name.endsWith(".docx")) {
        const nameLower = entry.name.toLowerCase();
        if (keywords.some(k => nameLower.includes(k.toLowerCase()))) {
          results.push(path.join(dir, entry.name));
        }
      }
    }
  }
  return results;
}

async function main() {
  // Auto-detect log
  const logsSnap = await db.collection("travelLogs").get();
  if (logsSnap.size !== 1) { console.error("Expected 1 travel log"); process.exit(1); }
  const logId = logsSnap.docs[0].id;
  console.log(`Log: ${logId}  Dry run: ${DRY_RUN}\n`);

  const logRef = db.collection("travelLogs").doc(logId);
  const tripsRef = logRef.collection("trips");
  const activitiesRef = logRef.collection("activities");
  const itinerariesRef = logRef.collection("itineraries");

  // Check for existing trips to avoid duplicates
  const existingSnap = await tripsRef.get();
  const existingDests = new Set(existingSnap.docs.map(d => d.data().destination));

  const trips = sqliteJson("SELECT * FROM trips ORDER BY id");
  console.log(`SQLite: ${trips.length} trips\n`);

  let created = 0, skipped = 0, actTotal = 0, itinTotal = 0;

  for (const trip of trips) {
    if (existingDests.has(trip.destination)) {
      console.log(`  SKIP (exists): ${trip.destination}`);
      skipped++;
      continue;
    }

    const { start, end } = parseDateRange(trip.dates || "");

    // Build rich notes
    const parts: string[] = [];
    if (trip.notes) parts.push(trip.notes);
    if (trip.travelers) parts.push(`Travelers: ${trip.travelers}`);
    if (trip.accommodation_notes) parts.push(`Accommodation: ${trip.accommodation_notes}`);
    if (trip.why_it_fits) parts.push(`Why it fits: ${trip.why_it_fits}`);
    if (trip.flight_estimate) parts.push(`Flight estimate: ${trip.flight_estimate}`);
    if (trip.daily_budget) parts.push(`Daily budget: ${trip.daily_budget}`);
    if (trip.trip_total_estimate) parts.push(`Trip total: ${trip.trip_total_estimate}`);
    if (trip.duration) parts.push(`Duration: ${trip.duration}`);
    if (trip.best_season) parts.push(`Best season: ${trip.best_season}`);
    if (trip.trip_type) parts.push(`Type: ${trip.trip_type}`);

    // Find and read matching Drive docs
    const driveDocs = findDriveDocs(trip.destination);
    const sourceRefParts: string[] = [];
    if (trip.source_refs) sourceRefParts.push(trip.source_refs);

    for (const docPath of driveDocs) {
      const relPath = path.relative(ARCHIVE, docPath);
      sourceRefParts.push(`Drive: ${relPath}`);
      // Read doc content and append key info to notes
      const content = readDocx(docPath);
      if (content && content.length > 50) {
        // Don't append full doc — just note it exists
        const lineCount = content.split("\n").filter(l => l.trim()).length;
        parts.push(`[Drive doc "${path.basename(docPath)}" — ${lineCount} lines of itinerary/planning detail]`);
      }
    }

    let status = trip.status || "Idea";
    if (status.startsWith("Idea")) status = "Idea";

    const tripData: Record<string, unknown> = {
      destination: trip.destination,
      status,
      region: trip.region || "",
      startDate: start ? toTs(start) : null,
      endDate: end ? toTs(end) : null,
      notes: parts.join("\n\n"),
      sourceRefs: sourceRefParts.join("\n"),
      flaggedForReview: trip.flagged_for_review === "1",
      reviewComment: trip.review_comment || "",
      created: now(),
      updated: now(),
    };

    let firestoreTripId: string;
    if (DRY_RUN) {
      console.log(`  CREATE: ${trip.destination} (${status}) — ${trip.dates || "no dates"} [${driveDocs.length} docs]`);
      firestoreTripId = `dry-${trip.id}`;
    } else {
      const ref = tripsRef.doc();
      await ref.set(tripData);
      firestoreTripId = ref.id;
      console.log(`  CREATED: ${trip.destination} → ${ref.id} [${driveDocs.length} docs]`);
    }
    created++;

    // Migrate activities
    const activities = sqliteJson(`SELECT * FROM activities WHERE trip_id = ${trip.id} ORDER BY id`);
    const actIdMap = new Map<string, string>();
    const dayGroups = new Map<number, { label: string; actIds: string[] }>();
    let hasItinerary = false;

    for (const act of activities) {
      const parsed = parseDayLoc(act.location || "");
      const location = parsed ? parsed.location : (act.location || "");

      const actData: Record<string, unknown> = {
        name: act.name,
        category: act.category || "Other",
        location,
        description: act.description || "",
        costNotes: act.cost_notes || "",
        durationEstimate: act.duration_estimate || "",
        tripId: firestoreTripId,
        created: now(),
        updated: now(),
      };

      let actId: string;
      if (DRY_RUN) {
        actId = `dry-act-${act.id}`;
      } else {
        const ref = activitiesRef.doc();
        await ref.set(actData);
        actId = ref.id;
      }
      actIdMap.set(act.id, actId);
      actTotal++;

      if (parsed) {
        hasItinerary = true;
        const group = dayGroups.get(parsed.dayNum) || { label: parsed.label, actIds: [] };
        group.actIds.push(actId);
        dayGroups.set(parsed.dayNum, group);
      }
    }

    if (!DRY_RUN && activities.length > 0) {
      process.stdout.write(`    ${activities.length} activities`);
    }

    // Create itinerary if day-structured
    if (hasItinerary) {
      const days = Array.from(dayGroups.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, g]) => ({
          label: g.label,
          slots: g.actIds.map(id => ({ activityId: id })),
        }));

      if (!DRY_RUN) {
        const ref = itinerariesRef.doc();
        await ref.set({
          tripId: firestoreTripId,
          name: "Actual",
          isActive: true,
          days,
          created: now(),
          updated: now(),
        });
        process.stdout.write(`, itinerary (${days.length} days)`);
      }
      itinTotal++;
    }

    if (!DRY_RUN && activities.length > 0) console.log();
  }

  console.log(`\nDone: ${created} created, ${skipped} skipped, ${actTotal} activities, ${itinTotal} itineraries`);
  process.exit(0);
}

main();
