/**
 * Insights — the life app's analysis surface (the "Insights" half of Coach).
 *
 * This is a lean shell: it owns the ONE memoized tz-aware `dayIndex`, the
 * pickable `Series` model, and a Trends · Correlate · Compare sub-nav. Each
 * analytical view is a focused component over `lib/analysis` (the pure,
 * tz-correct analysis lib); this file holds no chart math itself. The previous
 * 645-line god-component (local `setHours` day bucketing in
 * getLast30DaysData/getWeeklyData/getMonthData, a hand-rolled calendar heatmap,
 * three inline chart components, and a `?month=` param machine) is gone — its
 * day-math was the last local-tz day surface in the app, now replaced by the
 * shared `@homelab/backend` helpers the index and goal evaluator use.
 *
 * View + selection live in the URL (`?view=`, `?sel=`) so refresh and share
 * links round-trip the exact analysis. The Correlate view reads its X/Y from
 * the first two selected series, so one selection model serves all three views.
 */
import { useMemo } from "react";
import { useUrlString } from "@kirkl/shared";
import styled from "styled-components";
import { Segmented } from "antd";
import { useLifeContext } from "../life-context";
import { useTrackables } from "../lib/trackables";
import { userTz } from "../lib/useUserTz";
import { buildDayIndex } from "../lib/dayIndex";
import type { Granularity } from "../lib/analysis";
import type { LogEvent } from "../types";
import { buildSeries } from "./insights/model";
import { TrendsView } from "./insights/TrendsView";
import { CorrelateView } from "./insights/CorrelateView";
import { CompareView } from "./insights/CompareView";

const Container = styled.div`
  max-width: 800px;
  margin: 0 auto;
  padding: var(--space-md);
`;

const NavRow = styled.div`
  display: flex;
  justify-content: center;
  margin-bottom: var(--space-lg);
`;

type View = "trends" | "correlate" | "compare";
const VIEWS: View[] = ["trends", "correlate", "compare"];

/** Parse/serialize the comma-joined selection list. */
function parseSel(raw: string | null): string[] {
  return raw ? raw.split(",").filter(Boolean) : [];
}

export function Visualizations() {
  const { state } = useLifeContext();
  const trackables = useTrackables();
  const tz = userTz();

  const [viewRaw, setView] = useUrlString("view");
  const view: View = VIEWS.includes(viewRaw as View) ? (viewRaw as View) : "trends";

  const [selRaw, setSelRaw] = useUrlString("sel");
  const selected = useMemo(() => parseSel(selRaw), [selRaw]);
  const setSelected = (keys: string[]) => setSelRaw(keys.length ? keys.join(",") : null);

  const [granRaw, setGran] = useUrlString("g");
  const granularity: Granularity = granRaw === "week" ? "week" : "day";

  const [rangeRaw, setRange] = useUrlString("r");
  const range = rangeRaw === "90d" ? "90d" : "30d";

  const [periodRaw, setPeriod] = useUrlString("p");
  const period = periodRaw === "month" ? "month" : "week";

  const allEntries: LogEvent[] = useMemo(() => Array.from(state.entries.values()), [state.entries]);

  // ONE O(events) tz-aware pass feeds every view — no per-view event scans.
  const index = useMemo(() => buildDayIndex(allEntries, tz), [allEntries, tz]);
  const allSeries = useMemo(() => buildSeries(trackables, allEntries), [trackables, allEntries]);

  // Default the selection to the first series so a view never lands blank.
  const effectiveSel = selected.length > 0 ? selected : allSeries[0] ? [allSeries[0].key] : [];

  return (
    <Container>
      <NavRow>
        <Segmented<View>
          value={view}
          onChange={(v) => setView(v === "trends" ? null : v)}
          options={[
            { label: "Trends", value: "trends" },
            { label: "Correlate", value: "correlate" },
            { label: "Compare", value: "compare" },
          ]}
        />
      </NavRow>

      {view === "trends" && (
        <TrendsView
          index={index}
          allSeries={allSeries}
          allEntries={allEntries}
          trackables={trackables}
          tz={tz}
          selectedKeys={effectiveSel}
          onSelect={setSelected}
          granularity={granularity}
          onGranularity={(g) => setGran(g === "day" ? null : g)}
          range={range}
          onRange={(r) => setRange(r === "30d" ? null : r)}
        />
      )}

      {view === "correlate" && (
        <CorrelateView
          index={index}
          allSeries={allSeries}
          allEntries={allEntries}
          trackables={trackables}
          tz={tz}
          xKey={effectiveSel[0] ?? null}
          yKey={effectiveSel[1] ?? null}
          onX={(k) => setSelected([k, effectiveSel.find((s) => s !== k) ?? effectiveSel[1]].filter(Boolean) as string[])}
          onY={(k) => setSelected([effectiveSel[0], k].filter(Boolean) as string[])}
        />
      )}

      {view === "compare" && (
        <CompareView
          index={index}
          allSeries={allSeries}
          tz={tz}
          selectedKeys={effectiveSel}
          onSelect={setSelected}
          period={period}
          onPeriod={(p) => setPeriod(p === "week" ? null : p)}
        />
      )}
    </Container>
  );
}
