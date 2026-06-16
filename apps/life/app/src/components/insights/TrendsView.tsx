/**
 * Trends — 1–3 selected series overlaid on one time axis. Different units
 * coexist via per-series min–max normalization (each series scaled to 0–100 of
 * its own range); the tooltip shows real values so the normalization never
 * hides the actual magnitude. A single selected series renders as percentile-
 * shaded bars (magnitude shading over its own distribution) with day/bucket
 * drill-down; multiple series render as overlaid lines.
 */
import { useMemo } from "react";
import { Select, Segmented, Empty } from "antd";
import {
  ComposedChart,
  Bar,
  Line,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { MouseHandlerDataParam } from "recharts";
import type { DayIndex } from "../../lib/dayIndex";
import {
  series as buildAnalysisSeries,
  percentileScale,
  bucketRange,
  type Granularity,
} from "../../lib/analysis";
import type { Series } from "./model";
import { trackableArg } from "./model";
import { Controls, ChartBox, SERIES_COLORS, rampColor, useDrillDown } from "./shared";
import type { LogEvent } from "../../types";
import type { LifeManifestTrackable } from "@homelab/backend";

type RangeChoice = "30d" | "90d";

const RANGE_DAYS: Record<RangeChoice, number> = { "30d": 30, "90d": 90 };

interface MergedRow {
  date: string;
  [seriesKey: string]: string | number;
}

export function TrendsView({
  index,
  allSeries,
  allEntries,
  trackables,
  tz,
  selectedKeys,
  onSelect,
  granularity,
  onGranularity,
  range,
  onRange,
}: {
  index: DayIndex;
  allSeries: Series[];
  allEntries: LogEvent[];
  trackables: LifeManifestTrackable[];
  tz: string;
  selectedKeys: string[];
  onSelect: (keys: string[]) => void;
  granularity: Granularity;
  onGranularity: (g: Granularity) => void;
  range: RangeChoice;
  onRange: (r: RangeChoice) => void;
}) {
  const { openRange, modal } = useDrillDown(allEntries, trackables, tz);

  const picked = useMemo(
    () => selectedKeys.map((k) => allSeries.find((s) => s.key === k)).filter((s): s is Series => !!s),
    [selectedKeys, allSeries],
  );

  const { rows, normalizers } = useMemo(() => {
    const today = new Date();
    const from = new Date(today.getTime() - (RANGE_DAYS[range] - 1) * 24 * 60 * 60 * 1000);
    // Per-series points + a min/max for normalization. Buckets are sparse
    // (omitted when empty), so we merge them onto a shared date axis.
    const byDate = new Map<string, MergedRow>();
    const norm = new Map<string, (v: number) => number>();
    for (const s of picked) {
      const pts = buildAnalysisSeries(index, trackableArg(s), s.subjectIds, granularity, from, today, tz);
      const vals = pts.map((p) => p.value);
      const lo = vals.length ? Math.min(...vals) : 0;
      const hi = vals.length ? Math.max(...vals) : 0;
      norm.set(s.key, (v) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100));
      for (const p of pts) {
        let row = byDate.get(p.date);
        if (!row) {
          row = { date: p.date };
          byDate.set(p.date, row);
        }
        row[s.key] = p.value;
      }
    }
    const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return { rows: merged, normalizers: norm };
  }, [picked, index, granularity, range, tz]);

  if (allSeries.length === 0) return <Empty description="Nothing to chart yet" />;

  const single = picked.length === 1 ? picked[0] : null;
  // Magnitude shading for the single-series bar: percentile within its OWN
  // distribution over the visible window.
  const shade =
    single &&
    percentileScale(rows.map((r) => r[single.key]).filter((v): v is number => typeof v === "number"));

  // `activeLabel` is the clicked bucket's x-axis category — our bucket-key date.
  const handleClick = (data: MouseHandlerDataParam) => {
    const date = data.activeLabel;
    if (typeof date !== "string") return;
    const { from, to } = bucketRange(date, granularity, tz);
    const subjects = picked.flatMap((s) => s.subjectIds);
    openRange(from, to, subjects);
  };

  return (
    <div>
      <Controls>
        <Select
          mode="multiple"
          value={selectedKeys}
          // 1–3 series keeps the overlay legible; drop the oldest past 3.
          onChange={(keys) => onSelect((keys as string[]).slice(-3))}
          options={allSeries.map((s) => ({ value: s.key, label: s.label }))}
          maxTagCount="responsive"
          showSearch
          optionFilterProp="label"
          placeholder="Pick up to 3 trackables"
          style={{ minWidth: 240, flex: 1 }}
        />
        <Segmented<RangeChoice>
          value={range}
          onChange={onRange}
          options={[{ label: "30d", value: "30d" }, { label: "90d", value: "90d" }]}
        />
        <Segmented<Granularity>
          value={granularity}
          onChange={onGranularity}
          options={[{ label: "Day", value: "day" }, { label: "Week", value: "week" }]}
        />
      </Controls>

      {rows.length === 0 ? (
        <Empty description="No data in this window" />
      ) : (
        <ChartBox>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} onClick={handleClick}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              {/* Single series: real values on a visible auto axis. Multi: a
                  hidden 0–100 axis since the lines are min–max normalized so
                  different units can share the frame. */}
              <YAxis tick={{ fontSize: 10 }} domain={single ? [0, "auto"] : [0, 100]} hide={!single} />
              <Tooltip
                contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: "8px" }}
                formatter={(_v, name, item) => {
                  // Show the REAL value, not the normalized one.
                  const key = String(name);
                  const real = (item.payload as MergedRow)[key];
                  return [real, allSeries.find((s) => s.key === key)?.label ?? key];
                }}
              />
              {picked.length > 1 && <Legend formatter={(v) => allSeries.find((s) => s.key === v)?.label ?? v} />}

              {single ? (
                <Bar dataKey={single.key} radius={[2, 2, 0, 0]} isAnimationActive={false}>
                  {rows.map((r, i) => {
                    const v = r[single.key];
                    const pct = shade && typeof v === "number" ? shade(v) : 0;
                    return <Cell key={i} fill={rampColor(SERIES_COLORS[0], pct)} />;
                  })}
                </Bar>
              ) : (
                picked.map((s, i) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    // Normalized value feeds the shared axis; tooltip restores real.
                    dataKey={(row: MergedRow) => {
                      const v = row[s.key];
                      return typeof v === "number" ? normalizers.get(s.key)!(v) : null;
                    }}
                    name={s.key}
                    stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartBox>
      )}
      {modal}
    </div>
  );
}
