import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import admin from "firebase-admin";
import { readFileSync } from "node:fs";

admin.initializeApp({ projectId: "recipe-box-335721" });

// Load Google Maps API key from home app .env
let MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";
if (!MAPS_API_KEY) {
  try {
    const envFile = readFileSync(
      new URL("../../../sites/home/app/.env", import.meta.url), "utf8"
    );
    const match = envFile.match(/VITE_GOOGLE_MAPS_API_KEY=(.+)/);
    if (match) MAPS_API_KEY = match[1].trim();
  } catch { /* no .env file */ }
}
const db = admin.firestore();

// Rate-limited fetch with retry for Google APIs
async function googleFetch(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, options);

    if (resp.ok) return resp;

    // Retry on 429 (rate limit) and 503 (service unavailable)
    if ((resp.status === 429 || resp.status === 503) && attempt < maxRetries) {
      const retryAfter = resp.headers.get("retry-after");
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    // Retry once on 403 (sometimes transient during API propagation)
    if (resp.status === 403 && attempt < 1) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    return resp;
  }
}

// Auto-detect log ID
let LOG_ID = "";
async function getLogId() {
  if (LOG_ID) return LOG_ID;
  const snap = await db.collection("travelLogs").get();
  if (snap.size === 1) {
    LOG_ID = snap.docs[0].id;
    return LOG_ID;
  }
  throw new Error(`Expected 1 travel log, found ${snap.size}`);
}

function logRef() { return db.collection("travelLogs").doc(LOG_ID); }
function tripsRef() { return logRef().collection("trips"); }
function activitiesRef() { return logRef().collection("activities"); }
function itinerariesRef() { return logRef().collection("itineraries"); }
function now() { return admin.firestore.Timestamp.now(); }
function toTs(s) { return s ? admin.firestore.Timestamp.fromDate(new Date(s)) : null; }

function fmtDate(ts) {
  if (!ts) return "";
  return ts.toDate().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function fmtShort(ts) {
  if (!ts) return "";
  return ts.toDate().toISOString().split("T")[0];
}

const server = new McpServer({ name: "travel", version: "1.0.0" });

// ==========================================
// Trip tools
// ==========================================

server.tool("list_trips", "List all trips, optionally filtered by status or region", {
  status: z.string().optional().describe("Filter by status: Completed, Booked, Researching, Idea, Ongoing"),
  region: z.string().optional().describe("Filter by region"),
  flagged: z.boolean().optional().describe("Only show flagged trips"),
}, async ({ status, region, flagged }) => {
  await getLogId();
  let query = tripsRef();
  if (status) query = query.where("status", "==", status);
  if (region) query = query.where("region", "==", region);
  const snap = await query.get();
  let docs = snap.docs;
  if (flagged) docs = docs.filter(d => d.data().flaggedForReview);

  const rows = docs.map(d => {
    const t = d.data();
    return `${d.id} | ${t.destination} | ${t.status} | ${t.region || ""} | ${fmtShort(t.startDate)}-${fmtShort(t.endDate)}${t.flaggedForReview ? " [flagged]" : ""}`;
  });

  return { content: [{ type: "text", text: rows.length ? `${rows.length} trip(s):\n${rows.join("\n")}` : "No trips found." }] };
});

server.tool("get_trip", "Get full details of a trip including activities and itineraries", {
  tripId: z.string().describe("Firestore trip document ID"),
}, async ({ tripId }) => {
  await getLogId();
  const snap = await tripsRef().doc(tripId).get();
  if (!snap.exists) return { content: [{ type: "text", text: "Trip not found" }] };

  const d = snap.data();
  const lines = [
    `ID: ${snap.id}`,
    `Destination: ${d.destination}`,
    `Status: ${d.status}`,
    `Region: ${d.region || "—"}`,
    `Dates: ${fmtDate(d.startDate)} to ${fmtDate(d.endDate)}`,
    `Flagged: ${d.flaggedForReview ? `Yes — ${d.reviewComment || ""}` : "No"}`,
  ];
  if (d.notes) lines.push(`\nNotes:\n${d.notes}`);
  if (d.sourceRefs) lines.push(`\nSources:\n${d.sourceRefs}`);

  const actSnap = await activitiesRef().where("tripId", "==", tripId).get();
  if (!actSnap.empty) {
    lines.push(`\nActivities (${actSnap.size}):`);
    for (const a of actSnap.docs) {
      const ad = a.data();
      let line = `  ${a.id} | ${ad.name} (${ad.category}) — ${ad.location || ""}`;
      if (ad.description) line += `\n    ${ad.description}`;
      if (ad.costNotes) line += ` | Cost: ${ad.costNotes}`;
      if (ad.durationEstimate) line += ` | Duration: ${ad.durationEstimate}`;
      lines.push(line);
    }
  }

  const itinSnap = await itinerariesRef().where("tripId", "==", tripId).get();
  if (!itinSnap.empty) {
    for (const it of itinSnap.docs) {
      const id = it.data();
      lines.push(`\nItinerary: ${id.name}${id.isActive ? " (active)" : ""} [${it.id}]`);
      for (const day of id.days || []) {
        lines.push(`  ${day.label || "Day"}`);
        for (const slot of day.slots || []) {
          const actDoc = actSnap.docs.find(a => a.id === slot.activityId);
          const name = actDoc ? actDoc.data().name : slot.activityId;
          lines.push(`    ${slot.startTime || "—"} ${name}${slot.notes ? ` (${slot.notes})` : ""}`);
        }
      }
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("search_trips", "Full-text search across trips", {
  query: z.string().describe("Search query"),
}, async ({ query }) => {
  await getLogId();
  const q = query.toLowerCase();
  const snap = await tripsRef().get();
  const results = snap.docs.filter(d => {
    const t = d.data();
    return [t.destination, t.region, t.notes, t.sourceRefs, t.reviewComment]
      .filter(Boolean).some(s => s.toLowerCase().includes(q));
  });

  const rows = results.map(d => {
    const t = d.data();
    return `${d.id} | ${t.destination} | ${t.status} | ${t.region || ""}`;
  });
  return { content: [{ type: "text", text: rows.length ? rows.join("\n") : `No trips matching "${query}"` }] };
});

server.tool("create_trip", "Create a new trip", {
  destination: z.string(),
  status: z.enum(["Completed", "Booked", "Researching", "Idea", "Ongoing"]).default("Idea"),
  region: z.string().default(""),
  startDate: z.string().optional().describe("ISO date YYYY-MM-DD"),
  endDate: z.string().optional().describe("ISO date YYYY-MM-DD"),
  notes: z.string().default(""),
  sourceRefs: z.string().default(""),
}, async ({ destination, status, region, startDate, endDate, notes, sourceRefs }) => {
  await getLogId();
  const ref = tripsRef().doc();
  await ref.set({
    destination, status, region,
    startDate: toTs(startDate), endDate: toTs(endDate),
    notes, sourceRefs,
    flaggedForReview: false, reviewComment: "",
    created: now(), updated: now(),
  });
  return { content: [{ type: "text", text: `Created trip: ${ref.id}` }] };
});

server.tool("update_trip", "Update fields on an existing trip", {
  tripId: z.string(),
  destination: z.string().optional(),
  status: z.enum(["Completed", "Booked", "Researching", "Idea", "Ongoing"]).optional(),
  region: z.string().optional(),
  startDate: z.string().optional().describe("ISO date YYYY-MM-DD, or empty string to clear"),
  endDate: z.string().optional().describe("ISO date YYYY-MM-DD, or empty string to clear"),
  notes: z.string().optional(),
  sourceRefs: z.string().optional(),
  flaggedForReview: z.boolean().optional(),
  reviewComment: z.string().optional(),
}, async ({ tripId, ...fields }) => {
  await getLogId();
  const updates = { updated: now() };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === "startDate" || k === "endDate") {
      updates[k] = v === "" ? null : toTs(v);
    } else {
      updates[k] = v;
    }
  }
  await tripsRef().doc(tripId).update(updates);
  return { content: [{ type: "text", text: `Updated trip: ${tripId}` }] };
});

server.tool("delete_trip", "Delete a trip", {
  tripId: z.string(),
}, async ({ tripId }) => {
  await getLogId();
  await tripsRef().doc(tripId).delete();
  return { content: [{ type: "text", text: `Deleted trip: ${tripId}` }] };
});

// ==========================================
// Activity tools
// ==========================================

server.tool("list_activities", "List activities, optionally for a specific trip", {
  tripId: z.string().optional().describe("Filter by trip ID"),
}, async ({ tripId }) => {
  await getLogId();
  let query = activitiesRef();
  if (tripId) query = query.where("tripId", "==", tripId);
  const snap = await query.get();
  const rows = snap.docs.map(d => {
    const a = d.data();
    return `${d.id} | ${a.name} (${a.category}) | ${a.location || ""} | trip:${a.tripId}`;
  });
  return { content: [{ type: "text", text: rows.length ? `${rows.length} activity(ies):\n${rows.join("\n")}` : "No activities found." }] };
});

server.tool("create_activity", "Create a new activity. Use the STRUCTURED FIELDS (costNotes, durationEstimate, confirmationCode) for structured data — do NOT put costs, durations, or booking codes in the description. Description is ONLY for a brief qualifying note that doesn't fit elsewhere (under 100 chars). For flights: set location to the trip-relevant airport. For lodging: just the property name and address.", {
  name: z.string().describe("Short name. No m-dashes, no alternatives, no parenthetical asides."),
  category: z.string().default("Other"),
  location: z.string().default("").describe("City or area name only"),
  placeId: z.string().optional().describe("Google Place ID"),
  lat: z.number().optional().describe("Latitude"),
  lng: z.number().optional().describe("Longitude"),
  tripId: z.string().describe("Trip this activity belongs to"),
  description: z.string().default("").describe("Brief qualifying note ONLY. Under 100 chars. e.g. 'Book day of', 'Waitlist'"),
  details: z.string().optional().describe("Long-form info: what to do, logistics, tips. Shown in day view and hover."),
  setting: z.enum(["outdoor", "indoor", "either", ""]).optional().describe("Indoor/outdoor for weather flexibility"),
  bookingReqs: z.array(z.object({
    daysBefore: z.number().describe("Days before trip start to take this action"),
    action: z.string().describe("What to do, e.g. 'Book tickets at museofridakahlo.org.mx'"),
  })).optional().describe("Booking requirements with deadlines relative to trip start"),
  costNotes: z.string().default("").describe("Cost info, e.g. '$20 pp', 'free', '$5 entrance'"),
  durationEstimate: z.string().default("").describe("e.g. '2h', '30m', 'half day', 'evening'"),
  confirmationCode: z.string().optional().describe("Booking/reservation code"),
}, async ({ name, category, location, placeId, lat, lng, tripId, description, details, costNotes, durationEstimate, confirmationCode }) => {
  await getLogId();
  const ref = activitiesRef().doc();
  const data = { name, category, location, tripId, description, costNotes, durationEstimate, created: now(), updated: now() };
  if (confirmationCode) data.confirmationCode = confirmationCode;
  if (details) data.details = details;
  if (setting) data.setting = setting;
  if (bookingReqs?.length) data.bookingReqs = bookingReqs;
  if (placeId) data.placeId = placeId;
  if (lat != null) data.lat = lat;
  if (lng != null) data.lng = lng;
  await ref.set(data);
  return { content: [{ type: "text", text: `Created activity: ${ref.id}` }] };
});

server.tool("update_activity", "Update an existing activity", {
  activityId: z.string(),
  name: z.string().optional(),
  category: z.string().optional(),
  location: z.string().optional(),
  placeId: z.string().optional().describe("Google Place ID"),
  lat: z.number().optional().describe("Latitude"),
  lng: z.number().optional().describe("Longitude"),
  tripId: z.string().optional(),
  description: z.string().optional(),
  costNotes: z.string().optional(),
  durationEstimate: z.string().optional(),
  confirmationCode: z.string().optional().describe("Booking confirmation code"),
  details: z.string().optional().describe("Long-form description for day view"),
  setting: z.enum(["outdoor", "indoor", "either", ""]).optional().describe("Indoor/outdoor"),
  bookingReqs: z.array(z.object({
    daysBefore: z.number(),
    action: z.string(),
  })).optional().describe("Booking requirements with deadlines"),
}, async ({ activityId, ...fields }) => {
  await getLogId();
  const updates = { updated: now() };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) updates[k] = v;
  }
  await activitiesRef().doc(activityId).update(updates);
  return { content: [{ type: "text", text: `Updated activity: ${activityId}` }] };
});

server.tool("delete_activity", "Delete an activity", {
  activityId: z.string(),
}, async ({ activityId }) => {
  await getLogId();
  await activitiesRef().doc(activityId).delete();
  return { content: [{ type: "text", text: `Deleted activity: ${activityId}` }] };
});

// ==========================================
// Itinerary tools
// ==========================================

server.tool("list_itineraries", "List itineraries, optionally for a specific trip", {
  tripId: z.string().optional(),
}, async ({ tripId }) => {
  await getLogId();
  let query = itinerariesRef();
  if (tripId) query = query.where("tripId", "==", tripId);
  const snap = await query.get();
  const rows = snap.docs.map(d => {
    const it = d.data();
    return `${d.id} | ${it.name}${it.isActive ? " (active)" : ""} | ${(it.days || []).length} days | trip:${it.tripId}`;
  });
  return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "No itineraries found." }] };
});

const daySchema = z.object({
  date: z.string().optional().describe("ISO date"),
  label: z.string().describe("e.g. 'Day 1 — Mon Apr 12: Kona'"),
  lodgingActivityId: z.string().optional().describe("Activity ID for this night's accommodation"),
  flights: z.array(z.object({
    activityId: z.string(),
    startTime: z.string().optional(),
    notes: z.string().optional(),
  })).optional().describe("Flights/major transport for this day"),
  slots: z.array(z.object({
    activityId: z.string(),
    startTime: z.string().optional().describe("e.g. '9:00 AM'"),
    notes: z.string().optional(),
  })),
});

server.tool("create_itinerary", "Create a new itinerary for a trip", {
  tripId: z.string(),
  name: z.string().default("Actual").describe("e.g. 'Actual', 'Option A', 'Relaxed'"),
  isActive: z.boolean().default(true),
  days: z.array(daySchema).default([]),
}, async ({ tripId, name, isActive, days }) => {
  await getLogId();
  const ref = itinerariesRef().doc();
  await ref.set({ tripId, name, isActive, days, created: now(), updated: now() });
  return { content: [{ type: "text", text: `Created itinerary: ${ref.id}` }] };
});

server.tool("update_itinerary", "Update an itinerary (replace days array or metadata)", {
  itineraryId: z.string(),
  name: z.string().optional(),
  isActive: z.boolean().optional(),
  days: z.array(daySchema).optional(),
}, async ({ itineraryId, ...fields }) => {
  await getLogId();
  const updates = { updated: now() };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) updates[k] = v;
  }
  await itinerariesRef().doc(itineraryId).update(updates);
  return { content: [{ type: "text", text: `Updated itinerary: ${itineraryId}` }] };
});

server.tool("delete_itinerary", "Delete an itinerary", {
  itineraryId: z.string(),
}, async ({ itineraryId }) => {
  await getLogId();
  await itinerariesRef().doc(itineraryId).delete();
  return { content: [{ type: "text", text: `Deleted itinerary: ${itineraryId}` }] };
});

// ==========================================
// Places / Geocoding
// ==========================================

server.tool("search_place", "Search for a Google Place by name and optional location bias. Returns placeId, lat, lng, and address.", {
  query: z.string().describe("Place name, e.g. 'Kilauea Iki Trail, Hawaii Volcanoes National Park'"),
  locationBias: z.string().optional().describe("Bias results near this area, e.g. 'Kona, Hawaii' or '19.72,-155.09'"),
}, async ({ query, locationBias }) => {
  if (!MAPS_API_KEY) {
    return { content: [{ type: "text", text: "Error: Google Maps API key not configured" }] };
  }

  const body = { textQuery: query, languageCode: "en" };
  if (locationBias) {
    // If it looks like lat,lng use circle bias, otherwise use text
    const latLng = locationBias.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (latLng) {
      body.locationBias = {
        circle: {
          center: { latitude: parseFloat(latLng[1]), longitude: parseFloat(latLng[2]) },
          radius: 50000,
        },
      };
    }
  }

  const resp = await googleFetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": MAPS_API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.rating,places.userRatingCount,places.photos",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { content: [{ type: "text", text: `Places API error: ${resp.status} ${err}` }] };
  }

  const data = await resp.json();
  const places = data.places || [];

  if (places.length === 0) {
    return { content: [{ type: "text", text: `No places found for "${query}"` }] };
  }

  const lines = places.slice(0, 5).map((p) =>
    `${p.displayName?.text || "?"} | placeId: ${p.id} | ${p.location?.latitude?.toFixed(6)}, ${p.location?.longitude?.toFixed(6)} | ${p.formattedAddress || ""} | ${p.googleMapsUri || ""}`
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

server.tool("geocode_activity", "Look up a Google Place for an existing activity by its name+location, and update the activity with placeId, lat, lng", {
  activityId: z.string().describe("Activity to geocode"),
  searchQuery: z.string().optional().describe("Override search query (defaults to activity name + location)"),
}, async ({ activityId, searchQuery }) => {
  if (!MAPS_API_KEY) {
    return { content: [{ type: "text", text: "Error: Google Maps API key not configured" }] };
  }

  await getLogId();
  const snap = await activitiesRef().doc(activityId).get();
  if (!snap.exists) {
    return { content: [{ type: "text", text: `Activity not found: ${activityId}` }] };
  }

  const activity = snap.data();
  let query = searchQuery;
  if (!query) {
    // For flights/transportation, geocode to the trip destination, not home airport
    if (activity.category === "Transportation" && activity.tripId) {
      const tripSnap = await tripsRef().doc(activity.tripId).get();
      const tripDest = tripSnap.exists ? tripSnap.data().destination : "";
      // Extract destination airport or city from activity name/location
      const name = activity.name || "";
      const loc = activity.location || "";
      // If name contains → or -, try to find the airport at the trip destination
      const arrowMatch = name.match(/[→>-]\s*(.+?)(?:\s*\(|$)/);
      if (arrowMatch && tripDest) {
        // Use trip destination + "airport" for geocoding
        query = `${tripDest} airport`;
      } else {
        query = `${name}, ${loc}`.trim();
      }
    } else {
      query = `${activity.name}, ${activity.location}`.trim();
    }
  }

  const resp = await googleFetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": MAPS_API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.photos",
    },
    body: JSON.stringify({ textQuery: query, languageCode: "en" }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { content: [{ type: "text", text: `Places API error: ${resp.status} ${err}` }] };
  }

  const data = await resp.json();
  const place = (data.places || [])[0];

  if (!place) {
    return { content: [{ type: "text", text: `No place found for "${query}"` }] };
  }

  const photoRef = place.photos?.[0]?.name || "";
  const updates = {
    placeId: place.id,
    lat: place.location?.latitude || null,
    lng: place.location?.longitude || null,
    updated: now(),
  };
  if (place.rating) updates.rating = place.rating;
  if (place.userRatingCount) updates.ratingCount = place.userRatingCount;
  if (photoRef) updates.photoRef = photoRef;

  await activitiesRef().doc(activityId).update(updates);

  return {
    content: [{
      type: "text",
      text: `Geocoded "${activity.name}" → ${place.displayName?.text} (${place.formattedAddress})\n  placeId: ${place.id}\n  lat: ${updates.lat}, lng: ${updates.lng}${place.rating ? `\n  rating: ${place.rating} (${place.userRatingCount} reviews)` : ""}${photoRef ? "\n  photo: yes" : ""}`,
    }],
  };
});

server.tool("geocode_trip_activities", "Batch geocode all activities for a trip that don't have placeId yet", {
  tripId: z.string(),
}, async ({ tripId }) => {
  if (!MAPS_API_KEY) {
    return { content: [{ type: "text", text: "Error: Google Maps API key not configured" }] };
  }

  await getLogId();
  const snap = await activitiesRef().where("tripId", "==", tripId).get();
  const needGeocoding = snap.docs.filter((d) => !d.data().placeId);

  if (needGeocoding.length === 0) {
    return { content: [{ type: "text", text: "All activities already geocoded" }] };
  }

  // Get trip destination for smart flight geocoding
  const tripSnap = await tripsRef().doc(tripId).get();
  const tripDest = tripSnap.exists ? tripSnap.data().destination : "";

  const results = [];
  for (const doc of needGeocoding) {
    const activity = doc.data();
    let query;
    if (activity.category === "Transportation") {
      const name = activity.name || "";
      const arrowMatch = name.match(/[→>-]\s*(.+?)(?:\s*\(|$)/);
      if (arrowMatch && tripDest) {
        query = `${tripDest} airport`;
      } else {
        query = `${name}, ${activity.location || ""}`.trim();
      }
    } else {
      query = `${activity.name}, ${activity.location}`.trim();
    }

    try {
      const resp = await googleFetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": MAPS_API_KEY,
          "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.photos",
        },
        body: JSON.stringify({ textQuery: query, languageCode: "en" }),
      });

      if (!resp.ok) {
        results.push(`FAIL ${activity.name}: API error ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const place = (data.places || [])[0];

      if (!place) {
        results.push(`MISS ${activity.name}: no place found`);
        continue;
      }

      const batchUpdates = {
        placeId: place.id,
        lat: place.location?.latitude || null,
        lng: place.location?.longitude || null,
        updated: now(),
      };
      if (place.rating) batchUpdates.rating = place.rating;
      if (place.userRatingCount) batchUpdates.ratingCount = place.userRatingCount;
      const batchPhoto = place.photos?.[0]?.name || "";
      if (batchPhoto) batchUpdates.photoRef = batchPhoto;

      await activitiesRef().doc(doc.id).update(batchUpdates);

      results.push(`OK   ${activity.name} → ${place.displayName?.text} (${place.location?.latitude?.toFixed(4)}, ${place.location?.longitude?.toFixed(4)})${place.rating ? ` ★${place.rating}` : ""}`);
    } catch (err) {
      results.push(`ERR  ${activity.name}: ${err.message || err}`);
    }

    // Delay between requests to stay within rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  return { content: [{ type: "text", text: `Geocoded ${needGeocoding.length} activities:\n${results.join("\n")}` }] };
});

// ==========================================
// Stats
// ==========================================

server.tool("travel_stats", "Get collection statistics", {}, async () => {
  await getLogId();
  const [trips, activities, itineraries] = await Promise.all([
    tripsRef().get(), activitiesRef().get(), itinerariesRef().get(),
  ]);

  const statusCounts = {};
  const regionCounts = {};
  for (const d of trips.docs) {
    const t = d.data();
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    regionCounts[t.region || "No region"] = (regionCounts[t.region || "No region"] || 0) + 1;
  }

  const lines = [
    `Travel Log: ${LOG_ID}`,
    `Trips: ${trips.size}`,
    `Activities: ${activities.size}`,
    `Itineraries: ${itineraries.size}`,
    "",
    "By status:",
    ...Object.entries(statusCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
    "",
    "By region:",
    ...Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
});

// ==========================================
// Start — stdio or HTTP depending on --http flag
// ==========================================

const mode = process.argv.includes("--http") ? "http" : "stdio";
const port = parseInt(process.argv.find(a => a.startsWith("--port="))?.split("=")[1] || "8377");

if (mode === "http") {
  const app = express();
  app.use(express.json());

  const transports = {};

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (req.method === "POST" && !sessionId) {
      // New session
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      await server.connect(transport);
      transports[transport.sessionId] = transport;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = transports[sessionId];
    if (!transport) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }

    if (req.method === "DELETE") {
      await transport.handleRequest(req, res, req.body);
      delete transports[sessionId];
    } else {
      await transport.handleRequest(req, res, req.body);
    }
  });

  // CORS for Claude Desktop / Cowork
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const certDir = path.join(__dirname, "certs");

  if (fs.existsSync(path.join(certDir, "key.pem"))) {
    const httpsServer = https.createServer({
      key: fs.readFileSync(path.join(certDir, "key.pem")),
      cert: fs.readFileSync(path.join(certDir, "cert.pem")),
    }, app);
    httpsServer.listen(port, "0.0.0.0", () => {
      console.error(`Travel MCP server running on https://localhost:${port}/mcp`);
    });
  } else {
    app.listen(port, "0.0.0.0", () => {
      console.error(`Travel MCP server running on http://localhost:${port}/mcp (no certs found, use HTTP)`);
    });
  }
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
