/**
 * One-shot utility (historical/utility pattern): normalize itinerary slots in
 * place after the time-canonicalization + dayNote rename.
 *
 * For every day's `slots[]` and `flights[]` in every `travel_itineraries` row:
 *   (a) startTime  → canonical 24-hour "HH:MM" (drop if unparseable; absent stays absent)
 *   (b) notes      → dayNote (delete the legacy `notes` key)
 *
 * Idempotent: already-canonical times + already-`dayNote` slots are left
 * untouched, and an itinerary is only written back if at least one day changed.
 *
 * Usage (defaults to a dry run — pass --apply to actually write):
 *   source .env && npx tsx services/scripts/normalize-itinerary-slots.ts
 *   source .env && npx tsx services/scripts/normalize-itinerary-slots.ts --apply
 *
 * Auth: PB_URL (default https://api.$DOMAIN) + PB_ADMIN_PASSWORD, same as the
 * other scripts here; superuser auth as scott.kirklin@gmail.com.
 */
import PocketBase from "pocketbase";

const domain = process.env.DOMAIN || "kirkl.in";
const pbUrl = process.env.PB_URL || `https://api.${domain}`;
const password = process.env.PB_ADMIN_PASSWORD;
if (!password) {
  console.error("PB_ADMIN_PASSWORD not set");
  process.exit(1);
}

const apply = process.argv.slice(2).includes("--apply");

// --- canonicalSlotTime (mirrors apps/travel/app/src/time.ts) ----------------

function parseSlotTime(s?: string | null): number | null {
  if (!s) return null;
  const str = s.trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    const isPm = m[3].toLowerCase() === "p";
    if (h === 12) h = 0;
    if (isPm) h += 12;
    return h * 60 + min;
  }
  const h24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = Number(h24[1]);
    const min = Number(h24[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

function canonicalSlotTime(s?: string | null): string | undefined {
  const mins = parseSlotTime(s);
  if (mins == null) return undefined;
  const h = Math.floor(mins / 60);
  const min = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// --- slot/day normalization -------------------------------------------------

type Slot = Record<string, unknown>;
type Day = Record<string, unknown>;

/** Normalize one slot/flight in place. Returns true if it changed. */
function normalizeSlot(slot: Slot): boolean {
  let changed = false;

  // (a) startTime → canonical, drop if unparseable.
  if ("startTime" in slot) {
    const raw = typeof slot.startTime === "string" ? slot.startTime : undefined;
    const canon = canonicalSlotTime(raw);
    if (canon === undefined) {
      delete slot.startTime;
      changed = changed || raw !== undefined;
    } else if (canon !== raw) {
      slot.startTime = canon;
      changed = true;
    }
  }

  // (b) notes → dayNote (delete legacy key).
  if ("notes" in slot) {
    const note = slot.notes;
    delete slot.notes;
    if (slot.dayNote === undefined && typeof note === "string" && note) {
      slot.dayNote = note;
    }
    changed = true;
  }

  return changed;
}

function normalizeDay(day: Day): boolean {
  let changed = false;
  for (const key of ["slots", "flights"] as const) {
    const arr = day[key];
    if (Array.isArray(arr)) {
      for (const slot of arr) {
        if (slot && typeof slot === "object") {
          if (normalizeSlot(slot as Slot)) changed = true;
        }
      }
    }
  }
  return changed;
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`PB URL: ${pbUrl}`);
  console.log(apply ? "MODE: APPLY (will write)" : "MODE: dry-run (no writes; pass --apply to write)");

  const pb = new PocketBase(pbUrl);
  pb.autoCancellation(false);
  await pb.collection("_superusers").authWithPassword("scott.kirklin@gmail.com", password!);

  const itineraries = await pb.collection("travel_itineraries").getFullList({ sort: "created" });
  console.log(`Scanning ${itineraries.length} itineraries…`);

  let changedCount = 0;
  let slotChanges = 0;

  for (const it of itineraries) {
    const days = (Array.isArray(it.days) ? it.days : []) as Day[];
    let itChanged = false;
    let perItem = 0;
    for (const day of days) {
      if (day && typeof day === "object" && normalizeDay(day)) {
        itChanged = true;
        perItem++;
      }
    }
    if (!itChanged) continue;

    changedCount++;
    slotChanges += perItem;
    console.log(`  ${it.id} (${it.name || "unnamed"}): ${perItem} day(s) changed`);
    if (apply) {
      await pb.collection("travel_itineraries").update(it.id, { days });
    }
  }

  console.log(
    `\n${apply ? "Updated" : "Would update"} ${changedCount} itineraries (${slotChanges} days touched).`,
  );
  if (!apply && changedCount > 0) console.log("Re-run with --apply to persist.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
