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
import { spawnSync } from "node:child_process";
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

// Day A (2026-03-04 LA): one sleep + one quality (with labels) -> attach,
// labels merged onto the sleep event.
const sleepA = await addEvent({
  subject_id: "sleep",
  timestamp: "2026-03-04 14:00:00.000Z",
  entries: [{ name: "duration", type: "number", value: 420, unit: "min" }],
});
const qualA = await addEvent({
  subject_id: "sleep_quality",
  timestamp: "2026-03-04 16:00:00.000Z",
  entries: [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }],
  labels: { mood: "groggy" },
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
// Day D (2026-03-07 LA): quality only, on a 10-point scale -> create must
// carry scale 10 verbatim (not hardcode 5).
const qualD = await addEvent({
  subject_id: "sleep_quality",
  timestamp: "2026-03-07 16:00:00.000Z",
  entries: [{ name: "rating", type: "number", value: 7, unit: "rating", scale: 10 }],
});
// Day E (2026-03-08 LA): sleep already carrying a DIFFERENT rating + a
// quality -> conflict; merge --apply must leave both untouched and exit 2
// with the loud trailer.
const sleepE = await addEvent({
  subject_id: "sleep",
  timestamp: "2026-03-08 14:00:00.000Z",
  entries: [
    { name: "duration", type: "number", value: 400, unit: "min" },
    { name: "rating", type: "number", value: 2, unit: "rating", scale: 5 },
  ],
});
const qualE = await addEvent({
  subject_id: "sleep_quality",
  timestamp: "2026-03-08 16:00:00.000Z",
  entries: [{ name: "rating", type: "number", value: 4, unit: "rating", scale: 5 }],
});
// Category subjects: exercise w/ category+intensity, focus w/ multi-word
// category, exercise WITHOUT category (must stay untouched + exit 2), and
// a SELF-NAMED category ("Exercise" on subject exercise) whose rerun must
// report already-converted instead of missing-category.
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
const exSelf = await addEvent({
  subject_id: "exercise",
  timestamp: "2026-03-06 18:00:00.000Z",
  entries: [
    { name: "duration", type: "number", value: 40, unit: "min" },
    { name: "intensity", type: "number", value: 3, unit: "rating", scale: 5 },
  ],
  labels: { category: "Exercise" },
});
console.log("  Seeded 13 events");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runScript(script: string, extraArgs: string[], expectedExit = 0): string {
  const res = spawnSync(
    "pnpm",
    ["exec", "tsx", join(here, script), "--log", log.id, "--pb-url", pbUrl, ...extraArgs],
    { cwd: join(here, ".."), env: { ...process.env, PB_ADMIN_EMAIL: adminEmail, PB_ADMIN_PASSWORD: adminPassword }, encoding: "utf8" },
  );
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if ((res.status ?? -1) !== expectedExit) {
    console.error(out);
    throw new Error(`${script} ${extraArgs.join(" ")} exited ${res.status}, expected ${expectedExit}`);
  }
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

// --log without a value must hard-error, never silently mean "all logs".
console.log("");
console.log("  --- arg validation ---");
for (const script of ["merge-sleep-quality.ts", "split-category-subjects.ts"]) {
  const bad = spawnSync(
    "pnpm",
    ["exec", "tsx", join(here, script), "--pb-url", pbUrl, "--log"],
    { cwd: join(here, ".."), env: { ...process.env, PB_ADMIN_EMAIL: adminEmail, PB_ADMIN_PASSWORD: adminPassword }, encoding: "utf8" },
  );
  check(
    `${script}: --log without value exits 1`,
    bad.status === 1 && `${bad.stderr}`.includes("--log requires a value"),
    `status=${bad.status}`,
  );
}

// ---------------------------------------------------------------------------
// Apply script 1 and verify
// ---------------------------------------------------------------------------

console.log("");
console.log("  --- merge-sleep-quality --apply (exit 2: day-E conflict left) ---");
const mergeOut = runScript("merge-sleep-quality.ts", ["--apply"], 2);
check("merge --apply with a conflict exits 2 with a loud trailer", mergeOut.includes("UNRESOLVED EVENT(S)"));
let state = await fetchAll();

check("day A: rating 4 attached to sleep", ratingOf(state.get(sleepA)?.entries ?? []) === 4);
check("day A: quality labels merged onto sleep", state.get(sleepA)?.labels?.mood === "groggy");
check("day A: quality deleted", !state.has(qualA));
check("day B: quality deleted", !state.has(qualB));
const createdB = [...state.values()].filter(
  (r) => r.subject_id === "sleep" && ratingOf(r.entries) === 3 && !r.entries.some((e: any) => e.name === "duration"),
);
check("day B: sleep created with rating only", createdB.length === 1);
check("day C: rating 5 attached to NIGHT sleep", ratingOf(state.get(nightC)?.entries ?? []) === 5);
check("day C: nap untouched", ratingOf(state.get(napC)?.entries ?? []) === undefined);
check("day C: quality deleted", !state.has(qualC));
check("day D: quality deleted", !state.has(qualD));
const createdD = [...state.values()].filter(
  (r) =>
    r.subject_id === "sleep" &&
    r.entries.some((e: any) => e.name === "rating" && e.value === 7 && e.scale === 10),
);
check("day D: created sleep carries the 10-point scale verbatim", createdD.length === 1);
check("day E: conflicting sleep untouched (rating stays 2)", ratingOf(state.get(sleepE)?.entries ?? []) === 2);
check("day E: conflicting quality NOT deleted", state.has(qualE));

console.log("  --- merge-sleep-quality --apply (rerun, must no-op, conflict persists -> exit 2) ---");
runScript("merge-sleep-quality.ts", ["--apply"], 2);
const rerun1 = await fetchAll();
check("script 1 rerun is a no-op", JSON.stringify([...state].sort()) === JSON.stringify([...rerun1].sort()));

// ---------------------------------------------------------------------------
// Apply script 2 and verify
// ---------------------------------------------------------------------------

console.log("");
console.log("  --- split-category-subjects --apply (exit 2: missing-category left) ---");
const splitOut = runScript("split-category-subjects.ts", ["--apply"], 2);
check("split --apply with leftovers exits 2 with a loud trailer", splitOut.includes("UNRESOLVED EVENT(S)"));
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
const self = state.get(exSelf);
check("exercise/Exercise: stays subject exercise, intensity renamed, label gone",
  self?.subject_id === "exercise" && ratingOf(self?.entries ?? []) === 3 &&
  !(self?.entries ?? []).some((e: any) => e.name === "intensity") &&
  (self?.labels == null || self.labels.category === undefined));

console.log("  --- split-category-subjects --apply (rerun: no-op, already-converted reported) ---");
const rerunOut = runScript("split-category-subjects.ts", ["--apply"], 2);
check("rerun reports the self-named category as already-converted", rerunOut.includes("already converted"));
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
