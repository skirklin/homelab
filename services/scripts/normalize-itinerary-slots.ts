/**
 * One-shot utility (historical/utility pattern): normalize itinerary slots in
 * place after the time-canonicalization + dayNote rename.
 *
 * For every day's `slots[]` and `flights[]` in every `travel_itineraries` row:
 *   (a) startTime  → canonical 24-hour "HH:MM" WHEN parseable. Unparseable
 *                    free-text times ("morning", "after lunch", ranges, …) are
 *                    PRESERVED EXACTLY AS-IS — never dropped. The deployed app
 *                    tolerates legacy/free-text times on read, so keeping them
 *                    is lossless. Only rewritten when it canonicalizes to a
 *                    *different* value; absent stays absent.
 *   (b) notes      → dayNote (delete the legacy `notes` key; the value moves)
 *
 * Idempotent: already-canonical times + already-`dayNote` slots are left
 * untouched, and an itinerary is only written back if at least one day changed.
 *
 * Never drops data, and the dry-run proves it: the run reports how many
 * startTime values were canonicalized vs. already canonical, plus every
 * distinct unparseable startTime value it PRESERVED (with occurrence count and
 * the itinerary id(s) it appears in) so the operator can see nothing was lost.
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

/** A preserved (unparseable, non-empty) startTime value: how often, and where. */
interface PreservedTime {
  count: number;
  itineraryIds: Set<string>;
}

/** Run-wide stats so the dry-run can prove nothing was dropped. */
interface Stats {
  canonicalized: number; // startTime rewritten to a different canonical value
  alreadyCanonical: number; // startTime already in canonical "HH:MM" form
  /** distinct unparseable startTime values that were left untouched */
  preserved: Map<string, PreservedTime>;
}

function recordPreserved(stats: Stats, value: string, itineraryId: string): void {
  let entry = stats.preserved.get(value);
  if (!entry) {
    entry = { count: 0, itineraryIds: new Set() };
    stats.preserved.set(value, entry);
  }
  entry.count++;
  entry.itineraryIds.add(itineraryId);
}

/** Normalize one slot/flight in place. Returns true if it changed. */
function normalizeSlot(slot: Slot, itineraryId: string, stats: Stats): boolean {
  let changed = false;

  // (a) startTime → canonical WHEN parseable; otherwise preserve exactly as-is.
  //     Never delete an unparseable value — the app tolerates free-text times.
  if ("startTime" in slot) {
    const raw = typeof slot.startTime === "string" ? slot.startTime : undefined;
    const canon = canonicalSlotTime(raw);
    if (canon === undefined) {
      // Unparseable (or non-string / empty) — leave it untouched. Track only
      // non-empty free-text values so the operator can decide whether to fix them.
      if (typeof raw === "string" && raw.trim()) recordPreserved(stats, raw, itineraryId);
    } else if (canon !== raw) {
      slot.startTime = canon;
      stats.canonicalized++;
      changed = true;
    } else {
      stats.alreadyCanonical++;
    }
  }

  // (b) notes → dayNote (delete legacy key; the value moves to dayNote).
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

function normalizeDay(day: Day, itineraryId: string, stats: Stats): boolean {
  let changed = false;
  for (const key of ["slots", "flights"] as const) {
    const arr = day[key];
    if (Array.isArray(arr)) {
      for (const slot of arr) {
        if (slot && typeof slot === "object") {
          if (normalizeSlot(slot as Slot, itineraryId, stats)) changed = true;
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
  const stats: Stats = { canonicalized: 0, alreadyCanonical: 0, preserved: new Map() };

  for (const it of itineraries) {
    const days = (Array.isArray(it.days) ? it.days : []) as Day[];
    let itChanged = false;
    let perItem = 0;
    for (const day of days) {
      if (day && typeof day === "object" && normalizeDay(day, it.id, stats)) {
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
  console.log(
    `startTime: ${stats.canonicalized} canonicalized, ${stats.alreadyCanonical} already canonical.`,
  );

  // Prove nothing was dropped: enumerate every distinct preserved free-text time.
  if (stats.preserved.size === 0) {
    console.log("Preserved 0 unparseable startTime values — nothing dropped.");
  } else {
    const preservedTotal = [...stats.preserved.values()].reduce((n, e) => n + e.count, 0);
    console.log(
      `\nPreserved ${stats.preserved.size} unparseable startTime value(s) (not dropped), ${preservedTotal} occurrence(s):`,
    );
    const sorted = [...stats.preserved.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [value, entry] of sorted) {
      const ids = [...entry.itineraryIds].join(", ");
      console.log(`  ${JSON.stringify(value)} ×${entry.count}  [${ids}]`);
    }
  }

  if (!apply && changedCount > 0) console.log("\nRe-run with --apply to persist.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
