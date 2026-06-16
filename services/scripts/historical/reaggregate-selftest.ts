/**
 * Integration self-test for reaggregate-hourly-counters.ts against the
 * per-worktree TEST PB (never prod). Seeds a known fixture, runs the real CLI
 * script (`--apply`) as a subprocess, and asserts the outcome:
 *
 *   - daily rows have the correct summed/folded value + hwm + noon timestamp,
 *   - hourly rows are gone,
 *   - re-running --apply is a clean no-op (idempotent).
 *
 * Run it with the test env up:
 *   infra/test-env.sh up
 *   PB_URL="$(infra/test-env.sh url --pb)" pnpm tsx historical/reaggregate-selftest.ts
 *
 * Exit 0 = all assertions passed, 1 = a failure (prints which).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import PocketBase from "pocketbase";
import { noonOfDayUtc } from "./lib/reaggregate";

const PB_URL = process.env.PB_URL || process.env.PB_TEST_URL || "http://127.0.0.1:8091";
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL || "test-admin@test.local";
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD || "testpassword1234";
const TZ = "America/Los_Angeles";
const HERE = fileURLToPath(new URL(".", import.meta.url));

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);
await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);

// ---- Seed a fresh user + log -------------------------------------------------
const suffix = Date.now().toString(36);
const email = `reaggtest-${suffix}@test.local`;
const user = await pb.collection("users").create({
  email,
  password: "testpassword1234",
  passwordConfirm: "testpassword1234",
  timezone: TZ,
});
const log = await pb.collection("life_logs").create({ name: "Reaggregate self-test", owner: user.id });
console.log(`Seeded user ${user.id} / log ${log.id} (tz ${TZ}) on ${PB_URL}`);

const hourly = (subject: string, instant: string, value: number, unit: string, hwm: string) =>
  pb.collection("life_events").create({
    log: log.id,
    subject_id: subject,
    source_id: `hc:${subject}:${instant}`,
    timestamp: instant,
    created_by: user.id,
    entries: [{ name: "amount", type: "number", value, unit }],
    labels: { hwm },
  });

// Day A = 2026-06-13 PT (instants 2026-06-14T05/06Z map to Jun 13 PT).
// Day B = 2026-06-14 PT (instants 2026-06-14T20/21Z map to Jun 14 PT).
await hourly("steps", "2026-06-14T05:00:00.000Z", 500, "ct", "2026-06-14T05:59:00.000Z");
await hourly("steps", "2026-06-14T06:00:00.000Z", 300, "ct", "2026-06-14T06:59:00.000Z");
await hourly("steps", "2026-06-14T20:00:00.000Z", 1000, "ct", "2026-06-14T20:59:00.000Z");
await hourly("steps", "2026-06-14T21:00:00.000Z", 700, "ct", "2026-06-14T21:59:00.000Z");
await hourly("distance", "2026-06-14T05:00:00.000Z", 0.41, "mi", "2026-06-14T05:59:00.000Z");
await hourly("distance", "2026-06-14T06:00:00.000Z", 0.33, "mi", "2026-06-14T06:59:00.000Z");
await hourly("calories", "2026-06-14T20:00:00.000Z", 50.05, "kcal", "2026-06-14T20:59:00.000Z");
await hourly("calories", "2026-06-14T21:00:00.000Z", 50.05, "kcal", "2026-06-14T21:59:00.000Z");

// Pre-existing DAILY row for Day B steps (post-cutover deltas) to FOLD into.
// Its hwm is LATER than the hourly rows' (post-cutover), so it should win.
const foldDaily = await pb.collection("life_events").create({
  log: log.id,
  subject_id: "steps",
  source_id: "hc:steps:2026-06-14",
  timestamp: noonOfDayUtc("2026-06-14", TZ),
  created_by: user.id,
  entries: [{ name: "amount", type: "number", value: 2000, unit: "ct" }],
  labels: { hwm: "2026-06-15T02:00:00.000Z" },
});

// A daily row that must NOT be touched (no hourly rows for it) — guards against
// the script clobbering unrelated daily rows.
const untouchedDaily = await pb.collection("life_events").create({
  log: log.id,
  subject_id: "distance",
  source_id: "hc:distance:2026-06-10",
  timestamp: noonOfDayUtc("2026-06-10", TZ),
  created_by: user.id,
  entries: [{ name: "amount", type: "number", value: 3.21, unit: "mi" }],
  labels: { hwm: "2026-06-11T00:00:00.000Z" },
});

// ---- Run the real CLI script with --apply ------------------------------------
function runScript(): { code: number; out: string } {
  const res = spawnSync(
    "node",
    ["--import", "tsx", `${HERE}reaggregate-hourly-counters.ts`, "--log", log.id, "--pb-url", PB_URL, "--apply"],
    { env: { ...process.env, PB_ADMIN_EMAIL: ADMIN_EMAIL, PB_ADMIN_PASSWORD: ADMIN_PASSWORD }, encoding: "utf8" },
  );
  return { code: res.status ?? -1, out: (res.stdout || "") + (res.stderr || "") };
}

console.log("\n--- run 1 (--apply) ---");
const run1 = runScript();
console.log(run1.out.trim());
check("run 1 exit 0", run1.code === 0, `exit ${run1.code}`);

// ---- Assertions --------------------------------------------------------------
async function daily(sourceId: string) {
  const list = await pb.collection("life_events").getList(1, 1, {
    filter: pb.filter("log = {:log} && source_id = {:sid}", { log: log.id, sid: sourceId }),
    $autoCancel: false,
  });
  return list.items[0] ?? null;
}
function value(rec: any): number {
  const e = (rec?.entries || []).find((x: any) => typeof x.value === "number");
  return e ? e.value : NaN;
}
function hwm(rec: any): string {
  return rec?.labels?.hwm ?? "";
}

// Day A steps: created, sum = 800, hwm = max hourly = 06:59.
const stepsA = await daily("hc:steps:2026-06-13");
check("steps Jun13 created", !!stepsA);
check("steps Jun13 value 800", value(stepsA) === 800, `got ${value(stepsA)}`);
check("steps Jun13 hwm 06:59", hwm(stepsA) === "2026-06-14T06:59:00.000Z", hwm(stepsA));
check(
  "steps Jun13 timestamp noon PDT",
  stepsA && new Date(stepsA.timestamp).toISOString() === noonOfDayUtc("2026-06-13", TZ),
  stepsA?.timestamp,
);

// Day B steps: FOLDED into the pre-existing 2000 -> 2000 + 1700 = 3700; hwm = existing later one.
const stepsB = await daily("hc:steps:2026-06-14");
check("steps Jun14 folded id unchanged", stepsB?.id === foldDaily.id, stepsB?.id);
check("steps Jun14 value 3700", value(stepsB) === 3700, `got ${value(stepsB)}`);
check("steps Jun14 hwm = existing (later)", hwm(stepsB) === "2026-06-15T02:00:00.000Z", hwm(stepsB));

// Distance Jun13: 0.41 + 0.33 = 0.74.
const distA = await daily("hc:distance:2026-06-13");
check("distance Jun13 value 0.74", value(distA) === 0.74, `got ${value(distA)}`);

// Calories Jun14: 50.05 + 50.05 = 100.1.
const calB = await daily("hc:calories:2026-06-14");
check("calories Jun14 value 100.1", value(calB) === 100.1, `got ${value(calB)}`);

// All hourly rows gone.
const remainingHourly = await pb.collection("life_events").getFullList({
  filter: pb.filter("log = {:log} && source_id ~ {:t}", { log: log.id, t: "T" }),
  $autoCancel: false,
});
const hourlyLeft = remainingHourly.filter((r) => (r.source_id as string).includes("T"));
check("no hourly rows remain", hourlyLeft.length === 0, `left ${hourlyLeft.length}: ${hourlyLeft.map((r) => r.source_id).join(",")}`);

// Untouched unrelated daily row is intact.
const untouched = await pb.collection("life_events").getOne(untouchedDaily.id, { $autoCancel: false });
check("unrelated daily untouched", value(untouched) === 3.21 && hwm(untouched) === "2026-06-11T00:00:00.000Z");

// ---- Idempotency: re-run is a clean no-op ------------------------------------
console.log("\n--- run 2 (--apply, idempotent) ---");
const run2 = runScript();
console.log(run2.out.trim());
check("run 2 exit 0", run2.code === 0, `exit ${run2.code}`);
check("run 2 found 0 hourly rows", /Hourly rows found:\s+0/.test(run2.out), "expected 'Hourly rows found: 0'");

// Values unchanged after the no-op re-run.
const stepsBAfter = await daily("hc:steps:2026-06-14");
check("steps Jun14 unchanged after re-run", value(stepsBAfter) === 3700, `got ${value(stepsBAfter)}`);

// ---- Cleanup -----------------------------------------------------------------
const all = await pb.collection("life_events").getFullList({
  filter: pb.filter("log = {:log}", { log: log.id }),
  $autoCancel: false,
});
for (const r of all) await pb.collection("life_events").delete(r.id, { $autoCancel: false });
await pb.collection("life_logs").delete(log.id, { $autoCancel: false });
await pb.collection("users").delete(user.id, { $autoCancel: false });

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
