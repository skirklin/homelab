/**
 * Travel CLI — Firebase admin tool for managing travel data.
 *
 * Usage:
 *   npx tsx scripts/travel/cli.ts [--log=<logId>] <command> [args...]
 *
 * The --log flag is required for most commands. If omitted and there is exactly
 * one travel log, it will be auto-detected.
 *
 * Commands:
 *
 *   === Logs ===
 *   logs                           List all travel logs
 *   create-log <name> <userId>     Create a new travel log
 *   log-info                       Show current log details
 *
 *   === Trips ===
 *   list [--status=X] [--region=X] [--flagged]  List trips with optional filters
 *   show <tripId>                  Show trip details with activities and itineraries
 *   search <query>                 Full-text search across trips
 *   create-trip                    Create a trip (reads JSON from stdin)
 *   update-trip <tripId>           Update a trip (reads JSON from stdin)
 *   delete-trip <tripId>           Delete a trip
 *   flag <tripId> [comment]        Flag a trip for review
 *   unflag <tripId>                Remove flag from a trip
 *   flagged                        List all flagged trips
 *   set-status <tripId> <status>   Set trip status
 *   set-dates <tripId> <start> [end]  Set trip dates (ISO format)
 *
 *   === Activities ===
 *   activities [--trip=X]          List activities, optionally filtered by trip
 *   show-activity <activityId>     Show activity details
 *   add-activity                   Create activity (reads JSON from stdin)
 *   update-activity <activityId>   Update activity (reads JSON from stdin)
 *   delete-activity <activityId>   Delete an activity
 *   move-activity <activityId> <tripId>  Move activity to a different trip
 *
 *   === Itineraries ===
 *   itineraries [--trip=X]         List itineraries, optionally filtered by trip
 *   show-itinerary <itineraryId>   Show itinerary with day-by-day details
 *   create-itinerary               Create itinerary (reads JSON from stdin)
 *   update-itinerary <itineraryId> Update itinerary (reads JSON from stdin)
 *   set-itinerary <itineraryId>    Set itinerary days (reads JSON array from stdin)
 *   delete-itinerary <itineraryId> Delete an itinerary
 *   activate-itinerary <itineraryId>  Set an itinerary as active
 *
 *   === Bulk ===
 *   stats                          Show collection statistics
 *   export [--trip=X]              Export all data (or one trip) as JSON
 *   import                         Import data from JSON (reads stdin)
 *
 * JSON input examples:
 *
 *   create-trip:
 *     {"destination":"Tokyo","status":"Researching","region":"Asia","notes":"Cherry blossom season"}
 *
 *   add-activity:
 *     {"name":"Visit Fushimi Inari","category":"Sightseeing","location":"Kyoto","tripId":"abc123"}
 *
 *   create-itinerary:
 *     {"tripId":"abc123","name":"Option A","isActive":true,"days":[]}
 *
 *   set-itinerary (days array):
 *     [{"label":"Day 1","slots":[{"activityId":"xyz","startTime":"9:00 AM"}]}]
 */

import * as admin from "firebase-admin";

admin.initializeApp({ projectId: "recipe-box-335721" });
const db = admin.firestore();

let LOG_ID = "";

// ==========================================
// Helpers
// ==========================================

function logRef() {
  return db.collection("travelLogs").doc(LOG_ID);
}

function tripsRef() {
  return logRef().collection("trips");
}

function activitiesRef() {
  return logRef().collection("activities");
}

function itinerariesRef() {
  return logRef().collection("itineraries");
}

async function resolveLogId(flags: Record<string, string>): Promise<void> {
  if (flags.log) {
    LOG_ID = flags.log;
    return;
  }

  // Auto-detect if there's exactly one log
  const snapshot = await db.collection("travelLogs").get();
  if (snapshot.size === 1) {
    LOG_ID = snapshot.docs[0].id;
    return;
  }

  if (snapshot.empty) {
    console.error("Error: No travel logs found. Create one first:");
    console.error("  npx tsx scripts/travel/cli.ts create-log <name> <userId>");
  } else {
    console.error("Error: Multiple travel logs found. Specify one with --log=<id>:");
    for (const doc of snapshot.docs) {
      console.error(`  ${doc.id}  ${doc.data().name || ""}`);
    }
  }
  process.exit(1);
}

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      flags[key] = rest.join("=") || "true";
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));

    // If stdin is a TTY (no pipe), resolve immediately
    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

function formatTimestamp(ts: admin.firestore.Timestamp | null | undefined): string {
  if (!ts) return "—";
  return ts.toDate().toISOString().split("T")[0];
}

function formatDate(ts: admin.firestore.Timestamp | null | undefined): string {
  if (!ts) return "";
  return ts.toDate().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function now() {
  return admin.firestore.Timestamp.now();
}

function toTimestamp(dateStr: string): admin.firestore.Timestamp {
  return admin.firestore.Timestamp.fromDate(new Date(dateStr));
}

function printTable(rows: Record<string, string>[]) {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => (r[k] || "").length))
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "—".repeat(w)).join("  ");
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(keys.map((k, i) => (row[k] || "").padEnd(widths[i])).join("  "));
  }
}

// ==========================================
// Commands
// ==========================================

async function cmdLogs() {
  const snapshot = await db.collection("travelLogs").get();
  if (snapshot.empty) {
    console.log("No travel logs found.");
    return;
  }
  const rows = snapshot.docs.map((doc) => ({
    ID: doc.id,
    Name: doc.data().name || "",
    Owners: (doc.data().owners || []).join(", "),
    Created: formatTimestamp(doc.data().created),
  }));
  printTable(rows);
}

async function cmdCreateLog(name: string, userId: string) {
  const ref = db.collection("travelLogs").doc();
  await ref.set({
    name,
    owners: [userId],
    created: now(),
    updated: now(),
  });

  // Set user slug
  const userRef = db.collection("users").doc(userId);
  const userSnap = await userRef.get();
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  if (userSnap.exists) {
    const data = userSnap.data() || {};
    await userRef.update({
      travelSlugs: { ...data.travelSlugs, [slug]: ref.id },
    });
  } else {
    await userRef.set({ travelSlugs: { [slug]: ref.id } });
  }

  console.log(`Created travel log: ${ref.id}`);
  console.log(`User slug: ${slug} -> ${ref.id}`);
}

async function cmdLogInfo() {

  const snap = await logRef().get();
  if (!snap.exists) {
    console.error("Travel log not found:", LOG_ID);
    process.exit(1);
  }
  const data = snap.data()!;
  console.log(`ID:      ${snap.id}`);
  console.log(`Name:    ${data.name}`);
  console.log(`Owners:  ${(data.owners || []).join(", ")}`);
  console.log(`Created: ${formatDate(data.created)}`);
  console.log(`Updated: ${formatDate(data.updated)}`);
}

async function cmdListTrips(flags: Record<string, string>) {

  let query: admin.firestore.Query = tripsRef();

  if (flags.status) {
    query = query.where("status", "==", flags.status);
  }
  if (flags.region) {
    query = query.where("region", "==", flags.region);
  }

  const snapshot = await query.get();
  let docs = snapshot.docs;

  if (flags.flagged === "true") {
    docs = docs.filter((d) => d.data().flaggedForReview);
  }

  if (docs.length === 0) {
    console.log("No trips found.");
    return;
  }

  const rows = docs.map((doc) => {
    const d = doc.data();
    return {
      ID: doc.id,
      Destination: d.destination || "",
      Status: d.status || "",
      Region: d.region || "",
      Start: formatTimestamp(d.startDate),
      End: formatTimestamp(d.endDate),
      Flag: d.flaggedForReview ? "!" : "",
    };
  });

  // Sort: ongoing first, then booked, researching, idea, completed
  const statusOrder: Record<string, number> = {
    Ongoing: 0,
    Booked: 1,
    Researching: 2,
    Idea: 3,
    Completed: 4,
  };
  rows.sort((a, b) => (statusOrder[a.Status] ?? 5) - (statusOrder[b.Status] ?? 5));

  printTable(rows);
  console.log(`\n${rows.length} trip(s)`);
}

async function cmdShowTrip(tripId: string) {

  const snap = await tripsRef().doc(tripId).get();
  if (!snap.exists) {
    console.error("Trip not found:", tripId);
    process.exit(1);
  }

  const d = snap.data()!;
  console.log(`ID:          ${snap.id}`);
  console.log(`Destination: ${d.destination}`);
  console.log(`Status:      ${d.status}`);
  console.log(`Region:      ${d.region || "—"}`);
  console.log(`Start:       ${formatDate(d.startDate)}`);
  console.log(`End:         ${formatDate(d.endDate)}`);
  console.log(`Flagged:     ${d.flaggedForReview ? `Yes — ${d.reviewComment || "no comment"}` : "No"}`);
  console.log(`Created:     ${formatDate(d.created)}`);
  console.log(`Updated:     ${formatDate(d.updated)}`);

  if (d.notes) {
    console.log(`\n--- Notes ---\n${d.notes}`);
  }
  if (d.sourceRefs) {
    console.log(`\n--- Source Refs ---\n${d.sourceRefs}`);
  }

  // Show activities
  const actSnap = await activitiesRef().where("tripId", "==", tripId).get();
  if (!actSnap.empty) {
    console.log(`\n--- Activities (${actSnap.size}) ---`);
    for (const actDoc of actSnap.docs) {
      const a = actDoc.data();
      console.log(`  [${actDoc.id}] ${a.name} (${a.category}) — ${a.location || "no location"}`);
      if (a.description) console.log(`    ${a.description}`);
      if (a.costNotes) console.log(`    Cost: ${a.costNotes}`);
      if (a.durationEstimate) console.log(`    Duration: ${a.durationEstimate}`);
    }
  }

  // Show itineraries
  const itinSnap = await itinerariesRef().where("tripId", "==", tripId).get();
  if (!itinSnap.empty) {
    console.log(`\n--- Itineraries (${itinSnap.size}) ---`);
    for (const itinDoc of itinSnap.docs) {
      const it = itinDoc.data();
      console.log(`  [${itinDoc.id}] ${it.name}${it.isActive ? " (active)" : ""} — ${(it.days || []).length} days`);
      for (const day of it.days || []) {
        console.log(`    ${day.label || "Untitled day"}`);
        for (const slot of day.slots || []) {
          const actDoc = actSnap.docs.find((d) => d.id === slot.activityId);
          const actName = actDoc ? actDoc.data().name : slot.activityId;
          console.log(`      ${slot.startTime || "—"} ${actName}${slot.notes ? ` (${slot.notes})` : ""}`);
        }
      }
    }
  }
}

async function cmdSearch(query: string) {

  const q = query.toLowerCase();
  const snapshot = await tripsRef().get();
  const results = snapshot.docs.filter((doc) => {
    const d = doc.data();
    return (
      (d.destination || "").toLowerCase().includes(q) ||
      (d.region || "").toLowerCase().includes(q) ||
      (d.notes || "").toLowerCase().includes(q) ||
      (d.sourceRefs || "").toLowerCase().includes(q) ||
      (d.reviewComment || "").toLowerCase().includes(q)
    );
  });

  if (results.length === 0) {
    console.log(`No trips matching "${query}"`);
    return;
  }

  const rows = results.map((doc) => {
    const d = doc.data();
    return {
      ID: doc.id,
      Destination: d.destination || "",
      Status: d.status || "",
      Region: d.region || "",
    };
  });
  printTable(rows);
  console.log(`\n${rows.length} result(s)`);
}

async function cmdCreateTrip() {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON to stdin. Example:");
    console.error('  echo \'{"destination":"Tokyo","status":"Idea","region":"Asia"}\' | npx tsx scripts/travel/cli.ts create-trip');
    process.exit(1);
  }

  const data = JSON.parse(input);
  const ref = tripsRef().doc();
  await ref.set({
    destination: data.destination || "",
    status: data.status || "Idea",
    region: data.region || "",
    startDate: data.startDate ? toTimestamp(data.startDate) : null,
    endDate: data.endDate ? toTimestamp(data.endDate) : null,
    notes: data.notes || "",
    sourceRefs: data.sourceRefs || "",
    flaggedForReview: data.flaggedForReview || false,
    reviewComment: data.reviewComment || "",
    created: now(),
    updated: now(),
  });

  console.log(`Created trip: ${ref.id}`);
}

async function cmdUpdateTrip(tripId: string) {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON updates to stdin.");
    process.exit(1);
  }

  const data = JSON.parse(input);
  const updates: Record<string, unknown> = { updated: now() };

  for (const [key, value] of Object.entries(data)) {
    if (key === "startDate" || key === "endDate") {
      updates[key] = value ? toTimestamp(value as string) : null;
    } else {
      updates[key] = value;
    }
  }

  await tripsRef().doc(tripId).update(updates);
  console.log(`Updated trip: ${tripId}`);
}

async function cmdDeleteTrip(tripId: string) {

  await tripsRef().doc(tripId).delete();
  console.log(`Deleted trip: ${tripId}`);
}

async function cmdFlag(tripId: string, comment: string) {

  await tripsRef().doc(tripId).update({
    flaggedForReview: true,
    reviewComment: comment || "",
    updated: now(),
  });
  console.log(`Flagged trip: ${tripId}`);
}

async function cmdUnflag(tripId: string) {

  await tripsRef().doc(tripId).update({
    flaggedForReview: false,
    reviewComment: "",
    updated: now(),
  });
  console.log(`Unflagged trip: ${tripId}`);
}

async function cmdFlagged() {

  const snapshot = await tripsRef().where("flaggedForReview", "==", true).get();
  if (snapshot.empty) {
    console.log("No flagged trips.");
    return;
  }
  const rows = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      ID: doc.id,
      Destination: d.destination,
      Comment: d.reviewComment || "—",
    };
  });
  printTable(rows);
}

async function cmdSetStatus(tripId: string, status: string) {

  const valid = ["Completed", "Booked", "Researching", "Idea", "Ongoing"];
  if (!valid.includes(status)) {
    console.error(`Invalid status. Valid: ${valid.join(", ")}`);
    process.exit(1);
  }
  await tripsRef().doc(tripId).update({ status, updated: now() });
  console.log(`Set ${tripId} status to ${status}`);
}

async function cmdSetDates(tripId: string, start: string, end?: string) {

  const updates: Record<string, unknown> = {
    startDate: toTimestamp(start),
    updated: now(),
  };
  if (end) {
    updates.endDate = toTimestamp(end);
  }
  await tripsRef().doc(tripId).update(updates);
  console.log(`Set dates for ${tripId}: ${start}${end ? ` to ${end}` : ""}`);
}

// --- Activities ---

async function cmdListActivities(flags: Record<string, string>) {

  let query: admin.firestore.Query = activitiesRef();
  if (flags.trip) {
    query = query.where("tripId", "==", flags.trip);
  }

  const snapshot = await query.get();
  if (snapshot.empty) {
    console.log("No activities found.");
    return;
  }

  const rows = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      ID: doc.id,
      Name: d.name || "",
      Category: d.category || "",
      Location: d.location || "",
      TripID: d.tripId || "",
      Duration: d.durationEstimate || "",
    };
  });
  printTable(rows);
  console.log(`\n${rows.length} activity(ies)`);
}

async function cmdShowActivity(activityId: string) {

  const snap = await activitiesRef().doc(activityId).get();
  if (!snap.exists) {
    console.error("Activity not found:", activityId);
    process.exit(1);
  }
  const d = snap.data()!;
  console.log(`ID:          ${snap.id}`);
  console.log(`Name:        ${d.name}`);
  console.log(`Category:    ${d.category}`);
  console.log(`Location:    ${d.location || "—"}`);
  console.log(`Trip ID:     ${d.tripId || "—"}`);
  console.log(`Duration:    ${d.durationEstimate || "—"}`);
  console.log(`Cost:        ${d.costNotes || "—"}`);
  if (d.description) {
    console.log(`\n--- Description ---\n${d.description}`);
  }
}

async function cmdAddActivity() {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON to stdin. Example:");
    console.error('  echo \'{"name":"Visit temple","category":"Sightseeing","location":"Kyoto","tripId":"abc"}\' | ...');
    process.exit(1);
  }

  const data = JSON.parse(input);
  const ref = activitiesRef().doc();
  await ref.set({
    name: data.name || "",
    category: data.category || "Other",
    location: data.location || "",
    description: data.description || "",
    costNotes: data.costNotes || "",
    durationEstimate: data.durationEstimate || "",
    tripId: data.tripId || "",
    created: now(),
    updated: now(),
  });
  console.log(`Created activity: ${ref.id}`);
}

async function cmdUpdateActivity(activityId: string) {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON updates to stdin.");
    process.exit(1);
  }

  const data = JSON.parse(input);
  await activitiesRef().doc(activityId).update({ ...data, updated: now() });
  console.log(`Updated activity: ${activityId}`);
}

async function cmdDeleteActivity(activityId: string) {

  await activitiesRef().doc(activityId).delete();
  console.log(`Deleted activity: ${activityId}`);
}

async function cmdMoveActivity(activityId: string, tripId: string) {

  await activitiesRef().doc(activityId).update({ tripId, updated: now() });
  console.log(`Moved activity ${activityId} to trip ${tripId}`);
}

// --- Itineraries ---

async function cmdListItineraries(flags: Record<string, string>) {

  let query: admin.firestore.Query = itinerariesRef();
  if (flags.trip) {
    query = query.where("tripId", "==", flags.trip);
  }

  const snapshot = await query.get();
  if (snapshot.empty) {
    console.log("No itineraries found.");
    return;
  }

  const rows = snapshot.docs.map((doc) => {
    const d = doc.data();
    return {
      ID: doc.id,
      Name: d.name || "",
      TripID: d.tripId || "",
      Active: d.isActive ? "Yes" : "",
      Days: String((d.days || []).length),
    };
  });
  printTable(rows);
}

async function cmdShowItinerary(itineraryId: string) {

  const snap = await itinerariesRef().doc(itineraryId).get();
  if (!snap.exists) {
    console.error("Itinerary not found:", itineraryId);
    process.exit(1);
  }
  const d = snap.data()!;
  console.log(`ID:     ${snap.id}`);
  console.log(`Name:   ${d.name}`);
  console.log(`Trip:   ${d.tripId}`);
  console.log(`Active: ${d.isActive ? "Yes" : "No"}`);
  console.log(`Days:   ${(d.days || []).length}`);

  // Fetch activities for name resolution
  const actSnap = await activitiesRef().get();
  const actMap = new Map(actSnap.docs.map((a) => [a.id, a.data().name || a.id]));

  for (const [i, day] of (d.days || []).entries()) {
    console.log(`\n  ${day.label || `Day ${i + 1}`}${day.date ? ` (${day.date})` : ""}`);
    for (const slot of day.slots || []) {
      const name = actMap.get(slot.activityId) || slot.activityId;
      console.log(`    ${(slot.startTime || "—").padStart(8)}  ${name}${slot.notes ? `  — ${slot.notes}` : ""}`);
    }
    if (!day.slots || day.slots.length === 0) {
      console.log("    (empty)");
    }
  }
}

async function cmdCreateItinerary() {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON to stdin.");
    process.exit(1);
  }

  const data = JSON.parse(input);
  const ref = itinerariesRef().doc();
  await ref.set({
    tripId: data.tripId || "",
    name: data.name || "Untitled",
    isActive: data.isActive ?? true,
    days: data.days || [],
    created: now(),
    updated: now(),
  });
  console.log(`Created itinerary: ${ref.id}`);
}

async function cmdUpdateItinerary(itineraryId: string) {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON updates to stdin.");
    process.exit(1);
  }

  const data = JSON.parse(input);
  await itinerariesRef().doc(itineraryId).update({ ...data, updated: now() });
  console.log(`Updated itinerary: ${itineraryId}`);
}

async function cmdSetItinerary(itineraryId: string) {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON days array to stdin.");
    process.exit(1);
  }

  const days = JSON.parse(input);
  if (!Array.isArray(days)) {
    console.error("Error: Expected a JSON array of days.");
    process.exit(1);
  }

  await itinerariesRef().doc(itineraryId).update({ days, updated: now() });
  console.log(`Set ${days.length} days on itinerary: ${itineraryId}`);
}

async function cmdDeleteItinerary(itineraryId: string) {

  await itinerariesRef().doc(itineraryId).delete();
  console.log(`Deleted itinerary: ${itineraryId}`);
}

async function cmdActivateItinerary(itineraryId: string) {

  const snap = await itinerariesRef().doc(itineraryId).get();
  if (!snap.exists) {
    console.error("Itinerary not found:", itineraryId);
    process.exit(1);
  }

  const tripId = snap.data()!.tripId;

  // Deactivate all other itineraries for this trip
  const others = await itinerariesRef().where("tripId", "==", tripId).get();
  const batch = db.batch();
  for (const doc of others.docs) {
    batch.update(doc.ref, { isActive: doc.id === itineraryId, updated: now() });
  }
  await batch.commit();
  console.log(`Activated itinerary: ${itineraryId}`);
}

// --- Stats & Bulk ---

async function cmdStats() {

  const [trips, activities, itineraries] = await Promise.all([
    tripsRef().get(),
    activitiesRef().get(),
    itinerariesRef().get(),
  ]);

  console.log(`Travel Log: ${LOG_ID}`);
  console.log(`Trips:       ${trips.size}`);
  console.log(`Activities:  ${activities.size}`);
  console.log(`Itineraries: ${itineraries.size}`);

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const doc of trips.docs) {
    const s = doc.data().status || "Unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  console.log("\nTrips by status:");
  for (const [status, count] of Object.entries(statusCounts).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${status}: ${count}`);
  }

  // Region breakdown
  const regionCounts: Record<string, number> = {};
  for (const doc of trips.docs) {
    const r = doc.data().region || "No region";
    regionCounts[r] = (regionCounts[r] || 0) + 1;
  }
  console.log("\nTrips by region:");
  for (const [region, count] of Object.entries(regionCounts).sort(
    (a, b) => b[1] - a[1]
  )) {
    console.log(`  ${region}: ${count}`);
  }

  // Flagged count
  const flagged = trips.docs.filter((d) => d.data().flaggedForReview).length;
  if (flagged > 0) {
    console.log(`\nFlagged for review: ${flagged}`);
  }

  // Activity category breakdown
  const catCounts: Record<string, number> = {};
  for (const doc of activities.docs) {
    const c = doc.data().category || "Other";
    catCounts[c] = (catCounts[c] || 0) + 1;
  }
  if (Object.keys(catCounts).length > 0) {
    console.log("\nActivities by category:");
    for (const [cat, count] of Object.entries(catCounts).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`  ${cat}: ${count}`);
    }
  }
}

async function cmdExport(flags: Record<string, string>) {

  const output: Record<string, unknown> = { logId: LOG_ID };

  if (flags.trip) {
    // Export single trip
    const tripSnap = await tripsRef().doc(flags.trip).get();
    if (!tripSnap.exists) {
      console.error("Trip not found:", flags.trip);
      process.exit(1);
    }
    output.trip = { id: tripSnap.id, ...tripSnap.data() };

    const actSnap = await activitiesRef().where("tripId", "==", flags.trip).get();
    output.activities = actSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const itinSnap = await itinerariesRef().where("tripId", "==", flags.trip).get();
    output.itineraries = itinSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    // Export everything
    const [trips, activities, itineraries] = await Promise.all([
      tripsRef().get(),
      activitiesRef().get(),
      itinerariesRef().get(),
    ]);
    output.trips = trips.docs.map((d) => ({ id: d.id, ...d.data() }));
    output.activities = activities.docs.map((d) => ({ id: d.id, ...d.data() }));
    output.itineraries = itineraries.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  console.log(JSON.stringify(output, null, 2));
}

async function cmdImport() {

  const input = await readStdin();
  if (!input) {
    console.error("Error: Pipe JSON data to stdin.");
    process.exit(1);
  }

  const data = JSON.parse(input);
  const batch = db.batch();
  let count = 0;

  if (data.trips) {
    for (const trip of data.trips) {
      const { id, ...fields } = trip;
      const ref = id ? tripsRef().doc(id) : tripsRef().doc();
      if (fields.startDate && typeof fields.startDate === "string") {
        fields.startDate = toTimestamp(fields.startDate);
      }
      if (fields.endDate && typeof fields.endDate === "string") {
        fields.endDate = toTimestamp(fields.endDate);
      }
      if (!fields.created) fields.created = now();
      if (!fields.updated) fields.updated = now();
      batch.set(ref, fields, { merge: true });
      count++;
    }
  }

  if (data.activities) {
    for (const act of data.activities) {
      const { id, ...fields } = act;
      const ref = id ? activitiesRef().doc(id) : activitiesRef().doc();
      if (!fields.created) fields.created = now();
      if (!fields.updated) fields.updated = now();
      batch.set(ref, fields, { merge: true });
      count++;
    }
  }

  if (data.itineraries) {
    for (const itin of data.itineraries) {
      const { id, ...fields } = itin;
      const ref = id ? itinerariesRef().doc(id) : itinerariesRef().doc();
      if (!fields.created) fields.created = now();
      if (!fields.updated) fields.updated = now();
      batch.set(ref, fields, { merge: true });
      count++;
    }
  }

  await batch.commit();
  console.log(`Imported ${count} document(s)`);
}

// ==========================================
// Main
// ==========================================

async function main() {
  const args = process.argv.slice(2);
  const { positional, flags } = parseArgs(args);
  const command = positional[0] || "help";

  // Commands that don't need a log ID
  const noLogCommands = new Set(["logs", "create-log", "help"]);

  try {
    if (!noLogCommands.has(command)) {
      await resolveLogId(flags);
    }

    switch (command) {
      // Logs
      case "logs":
        await cmdLogs();
        break;
      case "create-log":
        if (positional.length < 3) {
          console.error("Usage: create-log <name> <userId>");
          process.exit(1);
        }
        await cmdCreateLog(positional[1], positional[2]);
        break;
      case "log-info":
        await cmdLogInfo();
        break;

      // Trips
      case "list":
        await cmdListTrips(flags);
        break;
      case "show":
        if (!positional[1]) {
          console.error("Usage: show <tripId>");
          process.exit(1);
        }
        await cmdShowTrip(positional[1]);
        break;
      case "search":
        if (!positional[1]) {
          console.error("Usage: search <query>");
          process.exit(1);
        }
        await cmdSearch(positional.slice(1).join(" "));
        break;
      case "create-trip":
        await cmdCreateTrip();
        break;
      case "update-trip":
        if (!positional[1]) {
          console.error("Usage: update-trip <tripId>");
          process.exit(1);
        }
        await cmdUpdateTrip(positional[1]);
        break;
      case "delete-trip":
        if (!positional[1]) {
          console.error("Usage: delete-trip <tripId>");
          process.exit(1);
        }
        await cmdDeleteTrip(positional[1]);
        break;
      case "flag":
        if (!positional[1]) {
          console.error("Usage: flag <tripId> [comment]");
          process.exit(1);
        }
        await cmdFlag(positional[1], positional.slice(2).join(" "));
        break;
      case "unflag":
        if (!positional[1]) {
          console.error("Usage: unflag <tripId>");
          process.exit(1);
        }
        await cmdUnflag(positional[1]);
        break;
      case "flagged":
        await cmdFlagged();
        break;
      case "set-status":
        if (positional.length < 3) {
          console.error("Usage: set-status <tripId> <status>");
          process.exit(1);
        }
        await cmdSetStatus(positional[1], positional[2]);
        break;
      case "set-dates":
        if (positional.length < 3) {
          console.error("Usage: set-dates <tripId> <start> [end]");
          process.exit(1);
        }
        await cmdSetDates(positional[1], positional[2], positional[3]);
        break;

      // Activities
      case "activities":
        await cmdListActivities(flags);
        break;
      case "show-activity":
        if (!positional[1]) {
          console.error("Usage: show-activity <activityId>");
          process.exit(1);
        }
        await cmdShowActivity(positional[1]);
        break;
      case "add-activity":
        await cmdAddActivity();
        break;
      case "update-activity":
        if (!positional[1]) {
          console.error("Usage: update-activity <activityId>");
          process.exit(1);
        }
        await cmdUpdateActivity(positional[1]);
        break;
      case "delete-activity":
        if (!positional[1]) {
          console.error("Usage: delete-activity <activityId>");
          process.exit(1);
        }
        await cmdDeleteActivity(positional[1]);
        break;
      case "move-activity":
        if (positional.length < 3) {
          console.error("Usage: move-activity <activityId> <tripId>");
          process.exit(1);
        }
        await cmdMoveActivity(positional[1], positional[2]);
        break;

      // Itineraries
      case "itineraries":
        await cmdListItineraries(flags);
        break;
      case "show-itinerary":
        if (!positional[1]) {
          console.error("Usage: show-itinerary <itineraryId>");
          process.exit(1);
        }
        await cmdShowItinerary(positional[1]);
        break;
      case "create-itinerary":
        await cmdCreateItinerary();
        break;
      case "update-itinerary":
        if (!positional[1]) {
          console.error("Usage: update-itinerary <itineraryId>");
          process.exit(1);
        }
        await cmdUpdateItinerary(positional[1]);
        break;
      case "set-itinerary":
        if (!positional[1]) {
          console.error("Usage: set-itinerary <itineraryId>");
          process.exit(1);
        }
        await cmdSetItinerary(positional[1]);
        break;
      case "delete-itinerary":
        if (!positional[1]) {
          console.error("Usage: delete-itinerary <itineraryId>");
          process.exit(1);
        }
        await cmdDeleteItinerary(positional[1]);
        break;
      case "activate-itinerary":
        if (!positional[1]) {
          console.error("Usage: activate-itinerary <itineraryId>");
          process.exit(1);
        }
        await cmdActivateItinerary(positional[1]);
        break;

      // Bulk
      case "stats":
        await cmdStats();
        break;
      case "export":
        await cmdExport(flags);
        break;
      case "import":
        await cmdImport();
        break;

      case "help":
      default:
        console.log(`Travel CLI — manage travel data in Firestore

Usage: npx tsx scripts/travel/cli.ts [--log=<logId>] <command> [args...]

The --log flag is auto-detected when there is exactly one travel log.

Logs:
  logs                             List all travel logs
  create-log <name> <userId>       Create a new travel log
  log-info                         Show current log details

Trips:
  list [--status=X] [--region=X] [--flagged]  List trips
  show <tripId>                    Show trip with activities & itineraries
  search <query>                   Search trips
  create-trip                      Create trip (JSON stdin)
  update-trip <tripId>             Update trip (JSON stdin)
  delete-trip <tripId>             Delete trip
  flag <tripId> [comment]          Flag trip for review
  unflag <tripId>                  Unflag trip
  flagged                          List flagged trips
  set-status <tripId> <status>     Set trip status
  set-dates <tripId> <start> [end] Set trip dates (ISO)

Activities:
  activities [--trip=X]            List activities
  show-activity <id>               Show activity details
  add-activity                     Create activity (JSON stdin)
  update-activity <id>             Update activity (JSON stdin)
  delete-activity <id>             Delete activity
  move-activity <id> <tripId>      Move to different trip

Itineraries:
  itineraries [--trip=X]           List itineraries
  show-itinerary <id>              Show itinerary details
  create-itinerary                 Create itinerary (JSON stdin)
  update-itinerary <id>            Update itinerary (JSON stdin)
  set-itinerary <id>               Set itinerary days (JSON array stdin)
  delete-itinerary <id>            Delete itinerary
  activate-itinerary <id>          Set as active itinerary

Bulk:
  stats                            Collection statistics
  export [--trip=X]                Export as JSON
  import                           Import from JSON (stdin)
`);
        break;
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  process.exit(0);
}

main();
