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
  onTimeRangeChange?: (range: '1Y' | '3Y' | '5Y' | 'ALL') => void
}

export function PerformanceVsBenchmark({ institution, onTimeRangeChange }: Props) {
  const [perfData, setPerfData] = useState<PerformancePoint[]>([])
  const [benchmarks, setBenchmarks] = useState<Record<string, BenchmarkSeries>>({})
  const [timeRange, setTimeRange] = useState<'1Y' | '3Y' | '5Y' | 'ALL'>('3Y')

  const handleTimeRangeChange = (range: '1Y' | '3Y' | '5Y' | 'ALL') => {
    setTimeRange(range)
    onTimeRangeChange?.(range)
  }

  useEffect(() => {
    fetchPerformance({ institution }).then(setPerfData)
    fetchBenchmarks(['SPY']).then(setBenchmarks)
  }, [institution])

  if (perfData.length === 0) return null

  // Group performance by account_id, using account_id as key to avoid name collisions
  const byAccount: Record<string, { label: string; points: PerformancePoint[] }> = {}
  for (const p of perfData) {
    if (!byAccount[p.account_id]) {
      let label = p.account_name
      // "General Investing (ESG) — Joint Automated Investing" → "Joint Auto. (ESG)"
      // "General Investing — Automated Investing" → "Automated Investing"
      // "Retirement — Traditional IRA" → "Traditional IRA"
      const parts = label.split(' — ')
      if (parts.length === 2) {
        const envelope = parts[0]
        const acct = parts[1]
        const strategyMatch = envelope.match(/\(([^)]+)\)/)
        label = strategyMatch ? `${acct} (${strategyMatch[1]})` : acct
      }
      byAccount[p.account_id] = { label, points: [] }
    }
    byAccount[p.account_id].points.push(p)
  }

  // Deduplicate labels by appending a suffix
  const labelCounts: Record<string, number> = {}
  for (const entry of Object.values(byAccount)) {
    labelCounts[entry.label] = (labelCounts[entry.label] ?? 0) + 1
  }
  const labelSeen: Record<string, number> = {}
  for (const entry of Object.values(byAccount)) {
    if (labelCounts[entry.label] > 1) {
      labelSeen[entry.label] = (labelSeen[entry.label] ?? 0) + 1
      entry.label = `${entry.label} #${labelSeen[entry.label]}`
    }
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

  // For accounts: use earned/invested to show actual investment return (not deposit growth)
  // For benchmarks: normalize price to % return from the start date
  function benchmarkToReturns(
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
      returns: filtered.map((p) => Math.round(((p.v - base) / base) * 1000) / 10),
    }
  }

  // Build account traces — earned/invested rebased to 0% at the start of the range
  const accountIds = Object.keys(byAccount).sort()
  const traces: Plotly.Data[] = accountIds.map((id, i) => {
    const { label, points: rawPoints } = byAccount[id]
    const points = rawPoints
      .filter((p) => p.date >= startDate && p.invested != null && p.invested > 0)
      .sort((a, b) => a.date.localeCompare(b.date))
    if (points.length === 0) return { x: [], y: [], name: label, type: 'scatter' as const, mode: 'lines' as const }

    const baseReturn = (points[0].earned ?? 0) / (points[0].invested ?? 1)
    return {
      x: points.map((p) => p.date),
      y: points.map((p) => {
        const totalReturn = (p.earned ?? 0) / (p.invested ?? 1)
        return Math.round((totalReturn - baseReturn) * 1000) / 10
      }),
      name: label,
      type: 'scatter' as const,
      mode: 'lines' as const,
      line: { color: COLORS[i % COLORS.length], width: 2 },
      hovertemplate: `%{x}<br>${label}: %{y:+.1f}%<extra></extra>`,
    }
  })

  // Add benchmark traces (price-based normalized returns)
  for (const [symbol, series] of Object.entries(benchmarks)) {
    const { dates, returns } = benchmarkToReturns(
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
                onClick={() => handleTimeRangeChange(r)}
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
            hoverformat: '+.1f',
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
