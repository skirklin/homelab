/**
 * Integration smoke test for the 2026-06 life history rewrite scripts
 * (merge-sleep-quality.ts / split-category-subjects.ts /
 *  fanout-session-events.ts) against a LOCAL test PocketBase. Refuses to run
 * against anything but localhost.
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
// Script 3: fanout-session-events
// ---------------------------------------------------------------------------

console.log("");
console.log("  ==============================================");
console.log("  Script 3: fanout-session-events");
console.log("  ==============================================");

// Seed all three session shapes + a live mood sample (no view_run, must not be
// mistaken for a child) + a partial/crashed run (one child pre-created).
const morningTs = "2026-05-21 15:00:00.000Z";
const eveningTs = "2026-05-22 04:00:00.000Z";
const weeklyTs = "2026-06-01 16:00:00.000Z";
const partialTs = "2026-05-23 15:00:00.000Z";

const fanMorning = await addEvent({
  subject_id: "morning_session",
  timestamp: morningTs,
  entries: [
    { name: "gratitude", type: "text", value: "coffee" },
    { name: "intention", type: "text", value: "ship it" },
    { name: "energy", type: "number", value: 4, unit: "rating", scale: 5 },
  ],
  labels: { source: "manual" },
});
const fanEvening = await addEvent({
  subject_id: "evening_session",
  timestamp: eveningTs,
  entries: [
    { name: "win", type: "text", value: "finished feature" },
    { name: "lesson", type: "text", value: "rest more" },
    { name: "intention_followup", type: "text", value: "yes" },
    { name: "mood", type: "number", value: 5, unit: "rating", scale: 5 },
  ],
  labels: { source: "manual" },
});
const fanWeekly = await addEvent({
  subject_id: "weekly_review_session",
  timestamp: weeklyTs,
  entries: [
    { name: "highlights", type: "text", value: "great week" },
    { name: "lows", type: "text", value: "tired" },
    { name: "lesson", type: "text", value: "pace yourself" },
    { name: "intention", type: "text", value: "plan ahead" },
    { name: "mood_rating", type: "number", value: 3, unit: "rating", scale: 5 },
  ],
  labels: { source: "manual" },
});
// A real mood sample on the same day as the evening session: subject_id mood,
// NO view_run. It must survive untouched and must not block the migrated child.
const liveMood = await addEvent({
  subject_id: "mood",
  timestamp: eveningTs,
  entries: [{ name: "rating", type: "number", value: 2, unit: "rating", scale: 5 }],
  labels: { source: "manual" },
});
// A partial/crashed run: a morning_session source whose `gratitude` child was
// already written (carries view_run). The rerun must create only the missing
// two children, then delete the source.
const fanPartial = await addEvent({
  subject_id: "morning_session",
  timestamp: partialTs,
  entries: [
    { name: "gratitude", type: "text", value: "sunshine" },
    { name: "intention", type: "text", value: "focus" },
    { name: "energy", type: "number", value: 3, unit: "rating", scale: 5 },
  ],
  labels: { source: "manual" },
});
const partialChild = await addEvent({
  subject_id: "gratitude",
  timestamp: partialTs,
  entries: [{ name: "note", type: "text", value: "sunshine" }],
  labels: { source: "manual", view: "morning", view_run: partialTs },
});
console.log("  Seeded 3 sessions + 1 live mood + 1 partial run (with 1 pre-created child)");

const fanSeedIds = [fanMorning, fanEvening, fanWeekly, liveMood, fanPartial, partialChild];

// Dry run must change nothing.
const beforeFan = await fetchAll();
console.log("");
console.log("  --- fanout dry run (must be inert) ---");
runScript("fanout-session-events.ts", []);
const afterFanDry = await fetchAll();
check("fanout dry-run changed nothing", JSON.stringify([...beforeFan].sort()) === JSON.stringify([...afterFanDry].sort()));

// --log without a value must hard-error.
{
  const bad = spawnSync(
    "pnpm",
    ["exec", "tsx", join(here, "fanout-session-events.ts"), "--pb-url", pbUrl, "--log"],
    { cwd: join(here, ".."), env: { ...process.env, PB_ADMIN_EMAIL: adminEmail, PB_ADMIN_PASSWORD: adminPassword }, encoding: "utf8" },
  );
  check("fanout: --log without value exits 1", bad.status === 1 && `${bad.stderr}`.includes("--log requires a value"), `status=${bad.status}`);
}

// Apply.
console.log("");
console.log("  --- fanout --apply ---");
runScript("fanout-session-events.ts", ["--apply"], 0);
state = await fetchAll();

// The fat session sources are gone.
check("fanout: morning_session source deleted", !state.has(fanMorning));
check("fanout: evening_session source deleted", !state.has(fanEvening));
check("fanout: weekly_review_session source deleted", !state.has(fanWeekly));
check("fanout: partial morning_session source deleted", !state.has(fanPartial));

// Helper: find a child by subject + view_run.
const childBy = (subjectId: string, viewRun: string) =>
  [...state.values()].find(
    (r) => r.subject_id === subjectId && (r.labels as any)?.view_run === viewRun,
  );

// Morning children.
const mGrat = childBy("gratitude", morningTs);
const mInt = childBy("daily_intention", morningTs);
const mEnergy = childBy("energy", morningTs);
check("fanout: morning -> gratitude note child", mGrat?.entries?.[0]?.value === "coffee" && (mGrat?.labels as any)?.view === "morning");
check("fanout: morning -> daily_intention note child", mInt?.entries?.[0]?.value === "ship it");
check(
  "fanout: morning -> energy rating child (canonical)",
  mEnergy?.entries?.[0]?.name === "rating" && mEnergy?.entries?.[0]?.value === 4 && (mEnergy?.entries?.[0] as any)?.unit === "rating",
);

// Evening children, incl. mood routed to the live series.
const eMood = childBy("mood", eveningTs);
check("fanout: evening -> daily_win", childBy("daily_win", eveningTs)?.entries?.[0]?.value === "finished feature");
check("fanout: evening -> daily_lesson", childBy("daily_lesson", eveningTs)?.entries?.[0]?.value === "rest more");
check("fanout: evening -> intention_followup", childBy("intention_followup", eveningTs)?.entries?.[0]?.value === "yes");
check(
  "fanout: evening mood -> mood series with canonical rating + view=evening",
  eMood?.entries?.[0]?.name === "rating" && eMood?.entries?.[0]?.value === 5 && (eMood?.labels as any)?.view === "evening",
);

// Weekly children, view id `weekly`, mood_rating -> mood.
const wMood = childBy("mood", weeklyTs);
check("fanout: weekly -> weekly_lesson (de-collided)", childBy("weekly_lesson", weeklyTs)?.entries?.[0]?.value === "pace yourself");
check("fanout: weekly -> weekly_intention (de-collided)", childBy("weekly_intention", weeklyTs)?.entries?.[0]?.value === "plan ahead");
check("fanout: weekly view id is 'weekly'", (childBy("highlights", weeklyTs)?.labels as any)?.view === "weekly");
check(
  "fanout: weekly mood_rating -> mood series with canonical rating",
  wMood?.entries?.[0]?.name === "rating" && wMood?.entries?.[0]?.value === 3,
);

// The live mood event is untouched; exactly 2 migrated mood children added.
check("fanout: live mood sample untouched", state.has(liveMood) && (state.get(liveMood)?.labels as any)?.view_run === undefined);
const moodChildren = [...state.values()].filter((r) => r.subject_id === "mood" && (r.labels as any)?.view_run);
check("fanout: exactly 2 migrated mood children", moodChildren.length === 2, `got ${moodChildren.length}`);

// Partial run: the pre-existing gratitude child survives (NOT duplicated), the
// missing two were created, the source deleted. `state` keys are ids, so check
// the original child id is still present and no second gratitude/partialTs row
// was created.
const partialGratRows = [...state].filter(
  ([, r]) => r.subject_id === "gratitude" && (r.labels as any)?.view_run === partialTs,
);
check(
  "fanout: partial pre-existing gratitude child kept (not duplicated)",
  partialGratRows.length === 1 && partialGratRows[0][0] === partialChild && partialGratRows[0][1].entries?.[0]?.value === "sunshine",
  `rows=${partialGratRows.length}`,
);
check("fanout: partial -> daily_intention created", childBy("daily_intention", partialTs)?.entries?.[0]?.value === "focus");
check("fanout: partial -> energy created", childBy("energy", partialTs)?.entries?.[0]?.value === 3);

// Rerun must be a clean no-op (exit 0).
console.log("  --- fanout --apply (rerun: clean no-op, exit 0) ---");
runScript("fanout-session-events.ts", ["--apply"], 0);
const fanRerun = await fetchAll();
check("fanout: rerun is a no-op", JSON.stringify([...state].sort()) === JSON.stringify([...fanRerun].sort()));

// Per-id final disposition of every fanout seed: the four fat sources are gone,
// the live mood sample + the pre-created partial child survive untouched.
const [seedMorning, seedEvening, seedWeekly, seedLiveMood, seedPartial, seedPartialChild] = fanSeedIds;
check("fanout seed: 3 session sources + partial source all deleted",
  ![seedMorning, seedEvening, seedWeekly, seedPartial].some((id) => state.has(id)));
check("fanout seed: live mood + pre-created partial child both survive",
  state.has(seedLiveMood) && state.has(seedPartialChild));

// ---------------------------------------------------------------------------
// Script 3b: data-loss guards (dup-source collision + non-numeric rated value).
// Both must leave their sources INTACT and make --apply exit 2 (non-zero). We
// seed these AFTER the happy path so they don't perturb the assertions above,
// and tear them down immediately so the final-cleanup count stays predictable.
// ---------------------------------------------------------------------------

console.log("");
console.log("  --- fanout guards: dup-source collision + NaN rated value ---");

// LOW-1: two DISTINCT morning_session rows sharing (subject_id, timestamp) —
// a genuine double-submit. The fanout child key is (newSubjectId, view_run=
// timestamp), so without the guard the second source would emit delete-only and
// lose its entries. Guard: both error, neither deleted, no children created.
const dupTs = "2026-05-25 15:00:00.000Z";
const dupA = await addEvent({
  subject_id: "morning_session",
  timestamp: dupTs,
  entries: [{ name: "gratitude", type: "text", value: "first submit" }],
  labels: { source: "manual" },
});
const dupB = await addEvent({
  subject_id: "morning_session",
  timestamp: dupTs,
  entries: [{ name: "gratitude", type: "text", value: "second submit" }],
  labels: { source: "manual" },
});

// MINOR-1: a non-numeric value on a rated id (mood) -> Number() = NaN. Must
// error (not write NaN) and leave the source intact.
const nanTs = "2026-05-26 04:00:00.000Z";
const nanSource = await addEvent({
  subject_id: "evening_session",
  timestamp: nanTs,
  entries: [
    { name: "win", type: "text", value: "shipped" },
    { name: "mood", type: "text", value: "not-a-number" },
  ],
  labels: { source: "manual" },
});

const guardOut = runScript("fanout-session-events.ts", ["--apply"], 2);
check("fanout guards: --apply exits 2 with the loud unmapped/error trailer",
  guardOut.includes("UNMAPPED ENTRY(IES)"));
state = await fetchAll();

// Dup-source: both colliding rows survive; no gratitude child was created for
// the colliding timestamp.
check("fanout dup-source: both colliding sources survive (no delete)",
  state.has(dupA) && state.has(dupB));
const dupChildren = [...state.values()].filter(
  (r) => r.subject_id === "gratitude" && (r.labels as any)?.view_run === dupTs,
);
check("fanout dup-source: no children created for the colliding pair",
  dupChildren.length === 0, `got ${dupChildren.length}`);

// NaN guard: the source survives, and crucially NO mood child carrying NaN was
// written for that timestamp.
check("fanout NaN guard: source with non-numeric rated value survives",
  state.has(nanSource));
const nanMoodChildren = [...state.values()].filter(
  (r) => r.subject_id === "mood" && (r.labels as any)?.view_run === nanTs,
);
check("fanout NaN guard: no NaN mood child written", nanMoodChildren.length === 0,
  `got ${nanMoodChildren.length}`);
const nanWinChild = [...state.values()].find(
  (r) => r.subject_id === "daily_win" && (r.labels as any)?.view_run === nanTs,
);
// The other (valid) entry must NOT have been created either: an error on any
// entry suppresses the source's delete, and a rerun would re-create the win as
// a skip-or-create — to keep the source fully reversible the source is intact
// AND its win child IS allowed to exist (create happened, delete suppressed).
check("fanout NaN guard: the valid sibling entry still fanned out (win child present)",
  nanWinChild?.entries?.[0]?.value === "shipped");
// Guard seeds (dupA, dupB, nanSource) + the valid win child are swept by the
// final cleanup loop below, which deletes every remaining event in the log.

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
