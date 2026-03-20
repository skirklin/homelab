import { useEffect, useState } from 'react'
import Plot from 'react-plotly.js'
import type { PerformancePoint, BenchmarkSeries } from '../api'
import { fetchPerformance, fetchBenchmarks } from '../api'

const COLORS = ['#818cf8', '#34d399', '#fb923c', '#f472b6', '#22d3ee']
const BENCHMARK_COLORS: Record<string, string> = {
  SPY: 'rgba(255,255,255,0.25)',
  VTI: 'rgba(255,255,255,0.2)',
  VT: 'rgba(255,255,255,0.15)',
}

interface Props {
  institution?: string
}

export function PerformanceVsBenchmark({ institution }: Props) {
  const [perfData, setPerfData] = useState<PerformancePoint[]>([])
  const [benchmarks, setBenchmarks] = useState<Record<string, BenchmarkSeries>>({})
  const [timeRange, setTimeRange] = useState<'1Y' | '3Y' | '5Y' | 'ALL'>('3Y')

  useEffect(() => {
    fetchPerformance({ institution }).then(setPerfData)
    fetchBenchmarks(['SPY']).then(setBenchmarks)
  }, [institution])

  if (perfData.length === 0) return null

  // Group performance by account
  const byAccount: Record<string, PerformancePoint[]> = {}
  for (const p of perfData) {
    const key = `${p.institution} / ${p.account_name}`
    if (!byAccount[key]) byAccount[key] = []
    byAccount[key].push(p)
  }

  // Determine date range
  const now = new Date()
  const cutoff: Record<string, Date> = {
    '1Y': new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()),
    '3Y': new Date(now.getFullYear() - 3, now.getMonth(), now.getDate()),
    '5Y': new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()),
    'ALL': new Date(2010, 0, 1),
  }
  const startDate = cutoff[timeRange].toISOString().slice(0, 10)

  // Normalize to percentage returns from start date for fair comparison
  function normalizeToReturns(
    dates: string[],
    values: number[],
  ): { dates: string[]; returns: number[] } {
    const filtered = dates
      .map((d, i) => ({ d, v: values[i] }))
      .filter((p) => p.d >= startDate && p.v > 0)
    if (filtered.length === 0) return { dates: [], returns: [] }
    const base = filtered[0].v
    return {
      dates: filtered.map((p) => p.d),
      returns: filtered.map((p) => ((p.v - base) / base) * 100),
    }
  }

  // Build account traces (normalized returns)
  const accountNames = Object.keys(byAccount).sort()
  const traces: Plotly.Data[] = accountNames.map((name, i) => {
    const points = byAccount[name].sort((a, b) => a.date.localeCompare(b.date))
    const { dates, returns } = normalizeToReturns(
      points.map((p) => p.date),
      points.map((p) => p.balance),
    )
    return {
      x: dates,
      y: returns,
      name,
      type: 'scatter' as const,
      mode: 'lines' as const,
      line: { color: COLORS[i % COLORS.length], width: 2 },
      hovertemplate: `%{x}<br>${name}: %{y:.1f}%<extra></extra>`,
    }
  })

  // Add benchmark traces
  for (const [symbol, series] of Object.entries(benchmarks)) {
    const { dates, returns } = normalizeToReturns(
      series.data.map((p) => p.date),
      series.data.map((p) => p.adj_close),
    )
    traces.push({
      x: dates,
      y: returns,
      name: `${series.name} (benchmark)`,
      type: 'scatter',
      mode: 'lines',
      line: {
        color: BENCHMARK_COLORS[symbol] ?? 'rgba(255,255,255,0.2)',
        width: 1.5,
        dash: 'dot',
      },
      hovertemplate: `%{x}<br>${series.name}: %{y:.1f}%<extra></extra>`,
    })
  }

  const ranges = ['1Y', '3Y', '5Y', 'ALL'] as const

  return (
    <section className="chart-section">
      <div className="section-header">
        <h2>Performance vs Benchmark</h2>
        <div className="controls">
          <div className="time-range-selector">
            {ranges.map((r) => (
              <button
                key={r}
                className={`range-btn ${timeRange === r ? 'active' : ''}`}
                onClick={() => setTimeRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>
      <Plot
        data={traces}
        layout={{
          paper_bgcolor: 'transparent',
          plot_bgcolor: 'transparent',
          font: { color: 'rgba(255,255,255,0.6)', size: 11 },
          margin: { l: 50, r: 20, t: 10, b: 40 },
          xaxis: {
            gridcolor: 'rgba(255,255,255,0.06)',
            linecolor: 'rgba(255,255,255,0.06)',
          },
          yaxis: {
            gridcolor: 'rgba(255,255,255,0.06)',
            linecolor: 'rgba(255,255,255,0.06)',
            ticksuffix: '%',
            zeroline: true,
            zerolinecolor: 'rgba(255,255,255,0.1)',
          },
          legend: {
            orientation: 'h',
            y: -0.12,
            font: { size: 10 },
          },
          hoverlabel: {
            bgcolor: '#1e1e3f',
            bordercolor: 'rgba(255,255,255,0.1)',
            font: { color: 'rgba(255,255,255,0.8)', size: 12 },
          },
          hovermode: 'x unified',
        }}
        config={{ responsive: true, displayModeBar: false }}
        useResizeHandler
        style={{ width: '100%', height: 450 }}
      />
    </section>
  )
}
