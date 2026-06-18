/**
 * READ-ONLY audit of production `*_session` life_events, to build the
 * Phase-B3 session→per-item fanout migration's id-map from REAL data rather
 * than from the manifest. Enumerates every distinct `entries[].name` per
 * session subject with counts, types/units, date range, and sample values,
 * and flags any name NOT in the current code manifest (esp. the historical
 * `mood` / `mood_rating` ratings that need an explicit disposition).
 *
 * Writes NOTHING. Usage:
 *   export $(grep -v '^#' .env | xargs)
 *   pnpm --filter @homelab/scripts exec tsx historical/audit-session-events.ts [--pb-url <url>] [--log <id>]
 */
import { connectAdmin, resolveLogs, fetchEvents } from "./lib/pb-admin";

const SESSION_SUBJECTS = ["morning_session", "evening_session", "weekly_review_session"];

// Current code manifest (apps/life/app/src/manifest.ts SESSIONS) — anything
// outside these per subject is a legacy/orphan name needing a disposition.
const EXPECTED: Record<string, string[]> = {
  morning_session: ["gratitude", "intention", "energy"],
  evening_session: ["intention_followup", "win", "lesson"],
  weekly_review_session: ["highlights", "lows", "lesson", "intention"],
};

function opt(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Stat {
  count: number;
  types: Set<string>;
  units: Set<string>;
  min: string;
  max: string;
  samples: Set<string>;
}

async function main() {
  const pbUrl = opt("--pb-url") || process.env.PB_URL || "https://api.kirkl.in";
  const onlyLog = opt("--log");
  console.log(`Session-event audit @ ${pbUrl}${onlyLog ? ` (log ${onlyLog})` : ""}`);

  const pb = await connectAdmin(pbUrl);
  const logs = await resolveLogs(pb, onlyLog);
  console.log(`  ${logs.length} life log(s)`);

  const agg: Record<string, Record<string, Stat>> = {};
  const perLog: Record<string, number> = {};
  let total = 0;

  for (const log of logs) {
    const events = await fetchEvents(pb, log.id, SESSION_SUBJECTS);
    perLog[log.id] = events.length;
    total += events.length;
    for (const ev of events) {
      const subj = ev.subject_id;
      (agg[subj] ??= {});
      for (const e of ev.entries) {
        const s = (agg[subj][e.name] ??= {
          count: 0,
          types: new Set(),
          units: new Set(),
          min: ev.timestamp,
          max: ev.timestamp,
          samples: new Set(),
        });
        s.count++;
        s.types.add(e.type);
        if ((e as { unit?: string }).unit) s.units.add((e as { unit?: string }).unit!);
        if (ev.timestamp < s.min) s.min = ev.timestamp;
        if (ev.timestamp > s.max) s.max = ev.timestamp;
        if (s.samples.size < 4 && e.type !== "text") s.samples.add(String((e as { value: unknown }).value));
      }
    }
  }

  const day = (t: string) => t.slice(0, 10);
  console.log(`\nTotal *_session events: ${total}`);
  console.log(`Per-log counts: ${Object.entries(perLog).map(([l, n]) => `${l}=${n}`).join(", ")}\n`);

  for (const subj of SESSION_SUBJECTS) {
    console.log(`### ${subj}`);
    const names = agg[subj] || {};
    const expected = new Set(EXPECTED[subj] || []);
    const rows = Object.entries(names).sort((a, b) => b[1].count - a[1].count);
    if (rows.length === 0) {
      console.log("  (no events)\n");
      continue;
    }
    for (const [name, s] of rows) {
      const flag = expected.has(name) ? "" : "   <<< LEGACY / NOT IN CURRENT MANIFEST";
      const vals = s.samples.size ? ` vals=[${[...s.samples].join(",")}]` : "";
      console.log(
        `  ${name.padEnd(20)} n=${String(s.count).padStart(4)}  ${[...s.types].join("/")}` +
          `${s.units.size ? "/" + [...s.units].join("/") : ""}  ${day(s.min)}..${day(s.max)}${vals}${flag}`,
      );
    }
    console.log();
  }

  console.log("=== mood / mood_rating disposition data (the B3 decision) ===");
  let found = false;
  for (const subj of SESSION_SUBJECTS) {
    for (const name of ["mood", "mood_rating"]) {
      const s = agg[subj]?.[name];
      if (s) {
        found = true;
        console.log(
          `  ${subj}.${name}: ${s.count} events, ${day(s.min)}..${day(s.max)}, ` +
            `unit=${[...s.units].join("/") || "-"}, samples=[${[...s.samples].join(",")}]`,
        );
      }
    }
  }
  if (!found) console.log("  none found — no legacy mood/mood_rating entries in any session event.");

  console.log("\n(read-only audit — nothing written)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
