/**
 * Correlate — pick an X and a Y trackable, scatter the days both were logged,
 * and read out the Pearson r + n with a plain-language gloss. Defaults to the
 * two most-logged numeric/rating series so the view lands on something useful.
 * Tapping a point drills into that day's events.
 */
import { useMemo } from "react";
import { Select, Empty } from "antd";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { DayIndex } from "../../lib/dayIndex";
import { series as buildAnalysisSeries, correlate, bucketRange, type CorrelationPoint } from "../../lib/analysis";
import type { Series } from "./model";
import { trackableArg, isNumeric } from "./model";
import { Controls, ChartBox, ReadOut, Hint, SERIES_COLORS, useDrillDown } from "./shared";
import type { LogEvent } from "../../types";
import type { LifeManifestTrackable } from "@homelab/backend";

// 90 days of overlap gives correlation enough samples without dragging in
// ancient, behaviorally-stale history.
const WINDOW_DAYS = 90;

/** Plain-language gloss for an r value (direction + strength). */
function describe(r: number, xLabel: string, yLabel: string): string {
  const dir = r > 0 ? "more" : "less";
  const mag = Math.abs(r);
  const strength = mag >= 0.6 ? "strongly" : mag >= 0.3 ? "tends to" : "weakly";
  if (mag < 0.1) return `No clear link between ${xLabel} and ${yLabel}.`;
  return `More ${xLabel} ${strength} tracks with ${dir} ${yLabel}.`;
}

export function CorrelateView({
  index,
  allSeries,
  allEntries,
  trackables,
  tz,
  xKey,
  yKey,
  onX,
  onY,
}: {
  index: DayIndex;
  allSeries: Series[];
  allEntries: LogEvent[];
  trackables: LifeManifestTrackable[];
  tz: string;
  xKey: string | null;
  yKey: string | null;
  onX: (k: string) => void;
  onY: (k: string) => void;
}) {
  const { openRange, modal } = useDrillDown(allEntries, trackables, tz);

  // Only numeric/rating series can correlate (a pure counter has no magnitude
  // axis worth regressing — though `happened` counts still work as a numeric
  // daily value, we keep the picker to magnitude/rating for a meaningful read).
  const numericSeries = useMemo(() => allSeries.filter(isNumeric), [allSeries]);

  const x = numericSeries.find((s) => s.key === xKey) ?? numericSeries[0];
  const y = numericSeries.find((s) => s.key === yKey) ?? numericSeries[1];

  const result = useMemo(() => {
    if (!x || !y || x.key === y.key) return null;
    const today = new Date();
    const from = new Date(today.getTime() - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
    const aSer = buildAnalysisSeries(index, trackableArg(x), x.subjectIds, "day", from, today, tz);
    const bSer = buildAnalysisSeries(index, trackableArg(y), y.subjectIds, "day", from, today, tz);
    return correlate(aSer, bSer);
  }, [x, y, index, tz]);

  if (numericSeries.length < 2) {
    return <Empty description="Need at least two numeric trackables to correlate" />;
  }

  const opts = numericSeries.map((s) => ({ value: s.key, label: s.label }));

  return (
    <div>
      <Controls>
        <Select
          value={x?.key}
          onChange={onX}
          options={opts}
          showSearch
          optionFilterProp="label"
          style={{ minWidth: 160, flex: 1 }}
          placeholder="X"
        />
        <span style={{ color: "var(--color-text-secondary)" }}>vs</span>
        <Select
          value={y?.key}
          onChange={onY}
          options={opts}
          showSearch
          optionFilterProp="label"
          style={{ minWidth: 160, flex: 1 }}
          placeholder="Y"
        />
      </Controls>

      {!result || x.key === y.key ? (
        <Hint>Pick two different trackables.</Hint>
      ) : result.r === null ? (
        <Hint>Not enough overlapping days to correlate ({result.n} shared {result.n === 1 ? "day" : "days"}).</Hint>
      ) : (
        <>
          <ReadOut>
            <strong>r = {result.r.toFixed(2)}</strong>, n = {result.n} days
            <div style={{ color: "var(--color-text-secondary)", marginTop: 4 }}>
              {describe(result.r, x.label, y.label)}
            </div>
          </ReadOut>
          <ChartBox>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart>
                <CartesianGrid stroke="var(--color-border)" />
                <XAxis type="number" dataKey="x" name={x.label} tick={{ fontSize: 10 }} />
                <YAxis type="number" dataKey="y" name={y.label} tick={{ fontSize: 10 }} />
                <ZAxis range={[60, 60]} />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "8px" }}
                  formatter={(v, name) => [v, name === "x" ? x.label : y.label]}
                />
                {/* Per-point onClick hands back the datum directly — a scatter
                    has no category axis, so the chart-level activeLabel can't
                    identify a point. */}
                <Scatter
                  data={result.points}
                  fill={SERIES_COLORS[0]}
                  onClick={(p) => {
                    // The clicked point's original datum rides on `payload`.
                    const date = (p?.payload as CorrelationPoint | undefined)?.date;
                    if (typeof date !== "string") return;
                    const { from, to } = bucketRange(date, "day", tz);
                    openRange(from, to, [...x.subjectIds, ...y.subjectIds]);
                  }}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </ChartBox>
        </>
      )}
      {modal}
    </div>
  );
}
