/**
 * Smoke tests for the three Insights views (Trends / Correlate / Compare). They
 * render each view over a small fixture (built through the real dayIndex +
 * series model) and assert the signature read-outs appear — the analysis lib
 * itself is unit-tested in lib/analysis.test.ts, so these only guard wiring:
 * the right picker, the Pearson read-out, the period delta table.
 *
 * `recharts` renders to an SVG via a ResponsiveContainer that measures 0×0 in
 * jsdom, so we don't assert on chart geometry — only on the surrounding chrome.
 * EventsEditModal is stubbed so we don't drag the backend in for a smoke test.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App as AntApp } from "antd";
import type { LifeEvent, LifeEntry, LifeManifestTrackable } from "@homelab/backend";

vi.mock("../EventsEditModal", () => ({ EventsEditModal: () => null }));

import { buildDayIndex } from "../../lib/dayIndex";
import { buildSeries } from "./model";
import { TrendsView } from "./TrendsView";
import { CorrelateView } from "./CorrelateView";
import { CompareView } from "./CompareView";

const TZ = "America/Los_Angeles";

let counter = 0;
function ev(subjectId: string, entries: LifeEntry[], iso: string): LifeEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    log: "log1",
    subjectId,
    timestamp: new Date(iso),
    entries,
    createdBy: "u1",
    created: iso,
    updated: iso,
  };
}
const num = (name: string, value: number, unit: string, scale?: number): LifeEntry[] => [
  { name, type: "number", value, unit, ...(scale ? { scale } : {}) },
];

const trackables: LifeManifestTrackable[] = [
  { id: "water", label: "Water", shape: "took", defaultUnit: "oz" },
  { id: "mood", label: "Mood", shape: "rated" },
];

// A fortnight of paired water + mood so every view has something to draw. We
// anchor relative to "now" because the views window off the real today.
function fixture(): LifeEvent[] {
  const out: LifeEvent[] = [];
  const now = Date.now();
  for (let i = 0; i < 14; i++) {
    const iso = new Date(now - i * 24 * 60 * 60 * 1000).toISOString();
    out.push(ev("water", num("amount", 10 + i, "oz"), iso));
    out.push(ev("mood", num("rating", 1 + (i % 5), "rating", 5), iso));
  }
  return out;
}

function setup() {
  const entries = fixture();
  const index = buildDayIndex(entries, TZ);
  const allSeries = buildSeries(trackables, entries);
  return { entries, index, allSeries };
}

const noop = () => {};

describe("TrendsView", () => {
  it("renders the multi-select picker and the granularity/range controls", () => {
    const { index, allSeries, entries } = setup();
    render(
      <AntApp>
        <TrendsView
          index={index}
          allSeries={allSeries}
          allEntries={entries}
          trackables={trackables}
          tz={TZ}
          selectedKeys={["water"]}
          onSelect={noop}
          granularity="day"
          onGranularity={noop}
          range="30d"
          onRange={noop}
        />
      </AntApp>,
    );
    expect(screen.getByText("30d")).toBeInTheDocument();
    expect(screen.getByText("Day")).toBeInTheDocument();
  });
});

describe("CorrelateView", () => {
  it("shows the Pearson read-out (r = …, n = … days) for two numeric series", () => {
    const { index, allSeries, entries } = setup();
    render(
      <AntApp>
        <CorrelateView
          index={index}
          allSeries={allSeries}
          allEntries={entries}
          trackables={trackables}
          tz={TZ}
          xKey="water"
          yKey="mood"
          onX={noop}
          onY={noop}
        />
      </AntApp>,
    );
    expect(screen.getByText(/r = /)).toBeInTheDocument();
    expect(screen.getByText(/days/)).toBeInTheDocument();
  });
});

describe("CompareView", () => {
  it("renders a period-over-period row per selected series", () => {
    const { index, allSeries } = setup();
    render(
      <AntApp>
        <CompareView
          index={index}
          allSeries={allSeries}
          tz={TZ}
          selectedKeys={["water", "mood"]}
          onSelect={noop}
          period="week"
          onPeriod={noop}
        />
      </AntApp>,
    );
    expect(screen.getByText("Water")).toBeInTheDocument();
    expect(screen.getByText("Mood")).toBeInTheDocument();
    // The "was <previous>" baseline label is the row's PoP signature.
    expect(screen.getAllByText(/was /).length).toBeGreaterThan(0);
  });
});
