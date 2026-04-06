/**
 * Migration script: SQLite travel.db → Firestore travelLogs
 *
 * Reads the cowork-generated travel.db and populates Firestore with:
 * - All trips (with parsed dates)
 * - All activities
 * - Itineraries (built from day-based activity location strings)
 *
 * Usage:
 *   npx tsx scripts/travel/migrate-sqlite.ts [--dry-run] [--log=<logId>]
 *
 * If --log is omitted, auto-detects the single travel log.
 * With --dry-run, prints what would be written without touching Firestore.
 */

import * as admin from "firebase-admin";
import Database from "better-sqlite3";

admin.initializeApp({ projectId: "recipe-box-335721" });
const db = admin.firestore();

const SQLITE_PATH = "/home/skirklin/travel-archive/travel.db";

// Parse CLI args
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const arg of args) {
  if (arg.startsWith("--")) {
    const [key, ...rest] = arg.slice(2).split("=");
    flags[key] = rest.join("=") || "true";
  }
}
const DRY_RUN = flags["dry-run"] === "true";

function now() {
  return admin.firestore.Timestamp.now();
}

function toTimestamp(dateStr: string): admin.firestore.Timestamp | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return admin.firestore.Timestamp.fromDate(d);
}

// Parse human-readable date strings like "July 4–15, 2017" or "May 24 – June 1, 2019"
function parseDateRange(dateStr: string): { start: Date | null; end: Date | null } {
  if (!dateStr) return { start: null, end: null };

  // Clean up special characters
  const clean = dateStr
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  // Try "Month Day-Day, Year" (e.g., "July 4-15, 2017")
  const sameMonth = clean.match(
    /^(\w+)\s+(\d+)\s*-\s*(\d+),?\s*(\d{4})$/
  );
  if (sameMonth) {
    const [, month, startDay, endDay, year] = sameMonth;
    return {
      start: new Date(`${month} ${startDay}, ${year}`),
      end: new Date(`${month} ${endDay}, ${year}`),
    };
  }

  // Try "Month Day - Month Day, Year" (e.g., "May 24 - June 1, 2019")
  const diffMonth = clean.match(
    /^(\w+)\s+(\d+)\s*-\s*(\w+)\s+(\d+),?\s*(\d{4})$/
  );
  if (diffMonth) {
    const [, m1, d1, m2, d2, year] = diffMonth;
    return {
      start: new Date(`${m1} ${d1}, ${year}`),
      end: new Date(`${m2} ${d2}, ${year}`),
    };
  }

  // Try "Mon Day, Year" for single dates
  const single = clean.match(/^(\w+)\s+(\d+),?\s*(\d{4})$/);
  if (single) {
    const d = new Date(clean);
    return { start: d, end: d };
  }

  // Try "Month-Month Year" (e.g., "June-July 2017")
  const monthRange = clean.match(/^(\w+)\s*-\s*(\w+)\s+(\d{4})$/);
  if (monthRange) {
    const [, m1, m2, year] = monthRange;
    return {
      start: new Date(`${m1} 1, ${year}`),
      end: new Date(`${m2} 28, ${year}`),
    };
  }

  // Try "Month Year" (e.g., "October 2019")
  const monthYear = clean.match(/^(\w+)\s+(\d{4})$/);
  if (monthYear) {
    const d = new Date(`${monthYear[1]} 1, ${monthYear[2]}`);
    return { start: d, end: null };
  }

  // Try "Apr Day-Day, Year" format
  const shortMonth = clean.match(
    /^(\w{3})\s+(\d+)\s*-\s*(\d+),?\s*(\d{4})$/
  );
  if (shortMonth) {
    const [, month, startDay, endDay, year] = shortMonth;
    return {
      start: new Date(`${month} ${startDay}, ${year}`),
      end: new Date(`${month} ${endDay}, ${year}`),
    };
  }

  // Try "Sep Year" or "September 2025"
  const approx = clean.match(/^(\w+)\s+(\d{4})$/);
  if (approx) {
    return { start: new Date(`${approx[1]} 1, ${approx[2]}`), end: null };
  }

  return { start: null, end: null };
}

// Parse day-based location string like "Day 1 — Fri May 24: Sedona"
// Returns { dayNum, label, location } or null
function parseDayLocation(location: string): { dayNum: number; label: string; location: string } | null {
  if (!location) return null;

  const match = location.match(
    /^Day\s+(\d+)\s*[–—-]\s*(.+?):\s*(.+)$/
  );
  if (match) {
    return {
      dayNum: parseInt(match[1]),
      label: location,
      location: match[3].trim(),
    };
  }
  return null;
}

interface SQLiteTrip {
  id: number;
  destination: string;
  region: string;
  duration: string | null;
  best_season: string | null;
  trip_type: string | null;
  status: string;
  travelers: string | null;
  dates: string | null;
  notes: string | null;
  why_it_fits: string | null;
  accommodation_notes: string | null;
  flight_estimate: string | null;
  daily_budget: string | null;
  trip_total_estimate: string | null;
  source_refs: string | null;
  flagged_for_review: number;
  review_comment: string | null;
}

interface SQLiteActivity {
  id: number;
  trip_id: number;
  location: string | null;
  name: string;
  category: string | null;
  description: string | null;
  priority: number;
  duration_estimate: string | null;
  cost_notes: string | null;
}

async function main() {
  // Resolve log ID
  let logId = flags.log;
  if (!logId) {
    const snapshot = await db.collection("travelLogs").get();
    if (snapshot.size === 1) {
      logId = snapshot.docs[0].id;
    } else {
      console.error("Specify --log=<id>");
      process.exit(1);
    }
  }

  console.log(`Target log: ${logId}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log();

  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  // Load all trips
  const trips = sqlite.prepare("SELECT * FROM trips ORDER BY id").all() as SQLiteTrip[];
  console.log(`Found ${trips.length} trips in SQLite`);

  // Load all activities
  const activities = sqlite.prepare("SELECT * FROM activities ORDER BY trip_id, id").all() as SQLiteActivity[];
  console.log(`Found ${activities.length} activities in SQLite`);

  // Group activities by trip
  const actByTrip = new Map<number, SQLiteActivity[]>();
  for (const act of activities) {
    const existing = actByTrip.get(act.trip_id) || [];
    existing.push(act);
    actByTrip.set(act.trip_id, existing);
  }

  // Load tags
  const tags = sqlite.prepare("SELECT * FROM trip_tags").all() as { trip_id: number; tag: string }[];
  const tagsByTrip = new Map<number, string[]>();
  for (const t of tags) {
    const existing = tagsByTrip.get(t.trip_id) || [];
    existing.push(t.tag);
    tagsByTrip.set(t.trip_id, existing);
  }

  const logRef = db.collection("travelLogs").doc(logId);
  const tripsRef = logRef.collection("trips");
  const activitiesRef = logRef.collection("activities");
  const itinerariesRef = logRef.collection("itineraries");

  // Map from SQLite trip ID to Firestore trip ID
  const tripIdMap = new Map<number, string>();

  let tripCount = 0;
  let actCount = 0;
  let itinCount = 0;

  for (const trip of trips) {
    const { start, end } = parseDateRange(trip.dates || "");

    // Build notes from extra fields
    const notesParts: string[] = [];
    if (trip.notes) notesParts.push(trip.notes);
    if (trip.why_it_fits) notesParts.push(`Why it fits: ${trip.why_it_fits}`);
    if (trip.travelers) notesParts.push(`Travelers: ${trip.travelers}`);
    if (trip.accommodation_notes) notesParts.push(`Accommodation: ${trip.accommodation_notes}`);
    if (trip.flight_estimate) notesParts.push(`Flight estimate: ${trip.flight_estimate}`);
    if (trip.daily_budget) notesParts.push(`Daily budget: ${trip.daily_budget}`);
    if (trip.trip_total_estimate) notesParts.push(`Trip total estimate: ${trip.trip_total_estimate}`);
    if (trip.duration) notesParts.push(`Duration: ${trip.duration}`);
    if (trip.best_season) notesParts.push(`Best season: ${trip.best_season}`);
    if (trip.trip_type) notesParts.push(`Trip type: ${trip.trip_type}`);
    const tripTags = tagsByTrip.get(trip.id);
    if (tripTags && tripTags.length > 0) notesParts.push(`Tags: ${tripTags.join(", ")}`);

    // Normalize status
    let status = trip.status || "Idea";
    if (status.startsWith("Idea")) status = "Idea";

    const tripData = {
      destination: trip.destination,
      status,
      region: trip.region || "",
      startDate: start ? admin.firestore.Timestamp.fromDate(start) : null,
      endDate: end ? admin.firestore.Timestamp.fromDate(end) : null,
      notes: notesParts.join("\n\n"),
      sourceRefs: trip.source_refs || "",
      flaggedForReview: trip.flagged_for_review === 1,
      reviewComment: trip.review_comment || "",
      created: now(),
      updated: now(),
    };

    if (DRY_RUN) {
      console.log(`[trip] ${trip.destination} (${status}) — ${trip.dates || "no dates"}`);
      tripIdMap.set(trip.id, `dry-run-${trip.id}`);
    } else {
      const tripRef = tripsRef.doc();
      await tripRef.set(tripData);
      tripIdMap.set(trip.id, tripRef.id);
    }
    tripCount++;

    // Migrate activities for this trip
    const tripActivities = actByTrip.get(trip.id) || [];
    const activityIdMap = new Map<number, string>(); // SQLite act ID -> Firestore act ID
    const dayGroups = new Map<number, { label: string; activities: { sqliteId: number; startTime?: string }[] }>();
    let hasItinerary = false;

    for (const act of tripActivities) {
      const parsed = parseDayLocation(act.location || "");
      const location = parsed ? parsed.location : (act.location || "");

      const actData = {
        name: act.name,
        category: act.category || "Other",
        location,
        description: act.description || "",
        costNotes: act.cost_notes || "",
        durationEstimate: act.duration_estimate || "",
        tripId: tripIdMap.get(trip.id) || "",
        created: now(),
        updated: now(),
      };

      let actId: string;
      if (DRY_RUN) {
        actId = `dry-act-${act.id}`;
      } else {
        const actRef = activitiesRef.doc();
        await actRef.set(actData);
        actId = actRef.id;
      }
      activityIdMap.set(act.id, actId);
      actCount++;

      // Group into itinerary days
      if (parsed) {
        hasItinerary = true;
        const group = dayGroups.get(parsed.dayNum) || { label: parsed.label, activities: [] };
        group.activities.push({ sqliteId: act.id });
        dayGroups.set(parsed.dayNum, group);
      }
    }

    // Create itinerary if we have day-based activities
    if (hasItinerary) {
      const days = Array.from(dayGroups.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, group]) => ({
          label: group.label,
          slots: group.activities.map((a) => ({
            activityId: activityIdMap.get(a.sqliteId) || "",
          })),
        }));

      const itinData = {
        tripId: tripIdMap.get(trip.id) || "",
        name: "Actual",
        isActive: true,
        days,
        created: now(),
        updated: now(),
      };

      if (DRY_RUN) {
        console.log(`  [itinerary] ${days.length} days`);
      } else {
        const itinRef = itinerariesRef.doc();
        await itinRef.set(itinData);
      }
      itinCount++;
    }
  }

  console.log(`\nMigrated: ${tripCount} trips, ${actCount} activities, ${itinCount} itineraries`);
  if (DRY_RUN) {
    console.log("(dry run — nothing written)");
  }

  sqlite.close();
  process.exit(0);
}

main();
