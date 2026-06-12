/**
 * Integration smoke test for the 2026-06 life history rewrite scripts
 * (merge-sleep-quality.ts / split-category-subjects.ts) against a LOCAL
 * test PocketBase. Refuses to run against anything but localhost.
 *
 * Seeds a throwaway user + life_log + events, runs each script as a child
 * process (dry-run first — asserting nothing changed — then --apply),
 * verifies the final DB state, and cleans up after itself. Exit 0 = PASS.
 *
 * Usage
 * -----
 *   infra/test-env.sh up                  # from the repo/worktree root
 *   PB_URL=$(infra/test-env.sh url --pb) \
 *     pnpm --filter @homelab/scripts exec tsx historical/smoke-life-rewrite.ts
 *
 * Test PB superuser creds default to the docker-compose.test.yml values;
 * override with PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD if yours differ.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import PocketBase from "pocketbase";

const pbUrl = process.env.PB_URL || "";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(pbUrl)) {
  console.error(`Refusing to run: PB_URL must point at a local test PB (got ${JSON.stringify(pbUrl)}).`);
  console.error("Start one with `infra/test-env.sh up` and pass PB_URL=$(infra/test-env.sh url --pb).");
  process.exit(1);
}
const adminEmail = process.env.PB_ADMIN_EMAIL || "test-admin@test.local";
const adminPassword = process.env.PB_ADMIN_PASSWORD || "testpassword1234";

const here = dirname(fileURLToPath(import.meta.url));

console.log("==============================================");
console.log("  smoke: life history rewrite scripts");
console.log("==============================================");
console.log(`  PB URL: ${pbUrl}`);

const pb = new PocketBase(pbUrl);
pb.autoCancellation(false);
await pb.collection("_superusers").authWithPassword(adminEmail, adminPassword);
console.log("  PB auth OK");

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const stamp = Date.now();
const user = await pb.collection("users").create({
  email: `smoke-life-${stamp}@test.local`,
  password: "smokepassword1234",
  passwordConfirm: "smokepassword1234",
  timezone: "America/Los_Angeles",
});
const log = await pb.collection("life_logs").create({ owner: user.id, name: `smoke-life-${stamp}` });
console.log(`  Seeded user ${user.id}, log ${log.id}`);

type Seed = Record<string, unknown>;
async function addEvent(seed: Seed): Promise<string> {
  const rec = await pb.collection("life_events").create({ log: log.id, created_by: user.id, ...seed });
  return rec.id;
}

// Day A (2026-03-04 LA): one sleep + one quality -> attach.
const sleepA = await addEvent({
  subject_id: "sleep",
  timestamp: "2026-03-04 14:00:00.000Z",
  entries: [{ name: "duration", type: "number", value: 420, unit: "min" }],
});
const qualA = await addEvent({
  subject_id: "sleep_quality",
  timestamp: "2026-03-04 16:00:00.000Z",
  entries: [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }],
});
// Day B (2026-03-05 LA): quality only -> create.
const qualB = await addEvent({
  subject_id: "sleep_quality",
  timestamp: "2026-03-05 16:00:00.000Z",
  entries: [{ name: "rating", type: "number", value: 3, unit: "rating", scale: 5 }],
});
// Day C (2026-03-06 LA): night sleep + nap + quality -> attach to night.
const nightC = await addEvent({
  subject_id: "sleep",
  timestamp: "2026-03-06 14:00:00.000Z",
  entries: [{ name: "duration", type: "number", value: 410, unit: "min" }],
});
const napC = await addEvent({
  subject_id: "sleep",
  timestamp: "2026-03-06 21:00:00.000Z",
  entries: [{ name: "duration", type: "number", value: 45, unit: "min" }],
});
const qualC = await addEvent({
  subject_id: "sleep_quality",
  timestamp: "2026-03-06 17:00:00.000Z",
  entries: [{ name: "rating", type: "number", value: 5, unit: "rating", scale: 5 }],
});
// Category subjects: exercise w/ category+intensity, focus w/ multi-word
// category, exercise WITHOUT category (must stay untouched).
const exPt = await addEvent({
  subject_id: "exercise",
  timestamp: "2026-03-04 18:00:00.000Z",
  entries: [
    { name: "duration", type: "number", value: 30, unit: "min" },
    { name: "intensity", type: "number", value: 4, unit: "rating", scale: 5 },
  ],
  labels: { category: "PT", source: "manual" },
});
const focusTrip = await addEvent({
  subject_id: "focus",
  timestamp: "2026-03-04 19:00:00.000Z",
  entries: [{ name: "duration", type: "number", value: 50, unit: "min" }],
  labels: { category: "trip planning" },
});
const exNoCat = await addEvent({
  subject_id: "exercise",
  timestamp: "2026-03-05 18:00:00.000Z",
  entries: [{ name: "duration", type: "number", value: 20, unit: "min" }],
  labels: { source: "manual" },
});
console.log("  Seeded 9 events");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runScript(script: string, extraArgs: string[]): string {
  const out = execFileSync(
    "pnpm",
    ["exec", "tsx", join(here, script), "--log", log.id, "--pb-url", pbUrl, ...extraArgs],
    { cwd: join(here, ".."), env: { ...process.env, PB_ADMIN_EMAIL: adminEmail, PB_ADMIN_PASSWORD: adminPassword }, encoding: "utf8" },
  );
  return out;
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function fetchAll(): Promise<Map<string, { subject_id: string; entries: any[]; labels: any }>> {
  const rows = await pb.collection("life_events").getFullList({
    filter: pb.filter("log = {:logId}", { logId: log.id }),
    $autoCancel: false,
  });
  return new Map(rows.map((r) => [r.id, { subject_id: r.subject_id, entries: r.entries ?? [], labels: r.labels ?? null }]));
}

const ratingOf = (entries: any[]): number | undefined =>
  entries.find((e) => e.name === "rating" && e.type === "number")?.value;

// ---------------------------------------------------------------------------
// Dry runs must change nothing
// ---------------------------------------------------------------------------

const before = await fetchAll();
console.log("");
console.log("  --- dry runs ---");
runScript("merge-sleep-quality.ts", []);
runScript("split-category-subjects.ts", []);
const afterDry = await fetchAll();
check("dry-run changed nothing", JSON.stringify([...before].sort()) === JSON.stringify([...afterDry].sort()));

// ---------------------------------------------------------------------------
// Apply script 1 and verify
// ---------------------------------------------------------------------------

console.log("");
console.log("  --- merge-sleep-quality --apply ---");
runScript("merge-sleep-quality.ts", ["--apply"]);
let state = await fetchAll();

check("day A: rating 4 attached to sleep", ratingOf(state.get(sleepA)?.entries ?? []) === 4);
check("day A: quality deleted", !state.has(qualA));
check("day B: quality deleted", !state.has(qualB));
const createdB = [...state.values()].filter(
  (r) => r.subject_id === "sleep" && ratingOf(r.entries) === 3 && !r.entries.some((e: any) => e.name === "duration"),
);
check("day B: sleep created with rating only", createdB.length === 1);
check("day C: rating 5 attached to NIGHT sleep", ratingOf(state.get(nightC)?.entries ?? []) === 5);
check("day C: nap untouched", ratingOf(state.get(napC)?.entries ?? []) === undefined);
check("day C: quality deleted", !state.has(qualC));

console.log("  --- merge-sleep-quality --apply (rerun, must no-op) ---");
runScript("merge-sleep-quality.ts", ["--apply"]);
const rerun1 = await fetchAll();
check("script 1 rerun is a no-op", JSON.stringify([...state].sort()) === JSON.stringify([...rerun1].sort()));

// ---------------------------------------------------------------------------
// Apply script 2 and verify
// ---------------------------------------------------------------------------

console.log("");
console.log("  --- split-category-subjects --apply ---");
runScript("split-category-subjects.ts", ["--apply"]);
state = await fetchAll();

const pt = state.get(exPt);
check("exercise/PT: subject is pt", pt?.subject_id === "pt");
check("exercise/PT: intensity renamed to rating", ratingOf(pt?.entries ?? []) === 4 && !(pt?.entries ?? []).some((e: any) => e.name === "intensity"));
check("exercise/PT: category label removed, source kept", JSON.stringify(pt?.labels) === JSON.stringify({ source: "manual" }));
const trip = state.get(focusTrip);
check("focus/trip planning: subject is trip-planning", trip?.subject_id === "trip-planning");
check("focus/trip planning: labels now empty", trip?.labels == null || Object.keys(trip.labels).length === 0);
const noCat = state.get(exNoCat);
check("exercise w/o category: untouched", noCat?.subject_id === "exercise" && JSON.stringify(noCat?.labels) === JSON.stringify({ source: "manual" }));

console.log("  --- split-category-subjects --apply (rerun, must no-op) ---");
runScript("split-category-subjects.ts", ["--apply"]);
const rerun2 = await fetchAll();
check("script 2 rerun is a no-op", JSON.stringify([...state].sort()) === JSON.stringify([...rerun2].sort()));

// ---------------------------------------------------------------------------
// Cleanup + verdict
// ---------------------------------------------------------------------------

console.log("");
for (const id of (await fetchAll()).keys()) {
  await pb.collection("life_events").delete(id, { $autoCancel: false });
}
await pb.collection("life_logs").delete(log.id, { $autoCancel: false });
await pb.collection("users").delete(user.id, { $autoCancel: false });
console.log("  Cleaned up seed data");

console.log("");
console.log(failures === 0 ? "  SMOKE PASS" : `  SMOKE FAIL (${failures} failed checks)`);
process.exit(failures === 0 ? 0 : 1);
