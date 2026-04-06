import { useEffect, useMemo, useState } from 'react'
import Plot from 'react-plotly.js'
import type { AllocationItem, PerformancePoint } from '../api'
import { fetchAllocation, fetchPerformance } from '../api'

const COLORS = [
  '#818cf8', '#34d399', '#fb923c', '#f472b6', '#22d3ee',
  '#fbbf24', '#a3e635', '#c084fc', '#94a3b8', '#f87171',
  '#67e8f9', '#e879f9',
]

type GroupBy = 'account' | 'institution' | 'asset_class'
type ValueMode = 'absolute' | 'percent'

function shortAccountName(name: string): string {
  const parts = name.split(' — ')
  if (parts.length === 2) {
    const m = parts[0].match(/\(([^)]+)\)/)
    return m ? `${parts[1]} (${m[1]})` : parts[1]
  }
  return name
}

export function AllocationOverTime() {
  const [perfData, setPerfData] = useState<PerformancePoint[]>([])
  const [allocation, setAllocation] = useState<AllocationItem[]>([])
  const [groupBy, setGroupBy] = useState<GroupBy>('institution')
  const [valueMode, setValueMode] = useState<ValueMode>('percent')

  useEffect(() => {
    fetchPerformance().then(setPerfData)
    fetchAllocation().then(setAllocation)
  }, [])

  // Build per-account asset class ratios from current holdings
  // This maps account_id → { asset_class → fraction }
  const accountAssetRatios = useMemo(() => {
    if (allocation.length === 0 || perfData.length === 0) return {}

    // allocation items have by_institution but not by_account.
    // We need the server to give us per-account allocation.
    // For now, approximate: each institution's allocation applies to all its accounts.
    // Build institution → { broad_class → fraction }
    const instTotals: Record<string, number> = {}
    const instByClass: Record<string, Record<string, number>> = {}
    for (const item of allocation) {
      for (const [inst, val] of Object.entries(item.by_institution)) {
        instTotals[inst] = (instTotals[inst] ?? 0) + val
        if (!instByClass[inst]) instByClass[inst] = {}
        instByClass[inst][item.broad_class] = (instByClass[inst][item.broad_class] ?? 0) + val
      }
    }

    const ratios: Record<string, Record<string, number>> = {}
    for (const [inst, total] of Object.entries(instTotals)) {
      if (total <= 0) continue
      ratios[inst] = {}
      for (const [cls, val] of Object.entries(instByClass[inst])) {
        ratios[inst][cls] = val / total
      }
    }
    return ratios
  }, [allocation, perfData])

  // Group performance data by month
  const { months, series } = useMemo(() => {
    if (perfData.length === 0) return { months: [] as string[], series: {} as Record<string, Record<string, number>> }

    // Build per-account monthly balances
    const acctMonthly: Record<string, { label: string; institution: string; data: Record<string, number> }> = {}
    for (const p of perfData) {
      if (!acctMonthly[p.account_id]) {
        acctMonthly[p.account_id] = {
          label: shortAccountName(p.account_name),
          institution: p.institution ?? 'other',
          data: {},
        }
      }
      acctMonthly[p.account_id].data[p.date.slice(0, 7)] = p.balance
    }

    const allMonths = new Set<string>()
    for (const acct of Object.values(acctMonthly)) {
      for (const m of Object.keys(acct.data)) allMonths.add(m)
    }
    const sortedMonths = [...allMonths].sort()

    // Build series based on groupBy mode
    const result: Record<string, Record<string, number>> = {}

    if (groupBy === 'account') {
      for (const acct of Object.values(acctMonthly)) {
        result[acct.label] = {}
        for (const m of sortedMonths) {
          result[acct.label][m] = acct.data[m] ?? 0
        }
      }
    } else if (groupBy === 'institution') {
      for (const acct of Object.values(acctMonthly)) {
        if (!result[acct.institution]) result[acct.institution] = {}
        for (const m of sortedMonths) {
          result[acct.institution][m] = (result[acct.institution][m] ?? 0) + (acct.data[m] ?? 0)
        }
      }
    } else {
      // asset_class: use institution-level ratios to estimate
      const assetClasses = new Set<string>()
      for (const ratios of Object.values(accountAssetRatios)) {
        for (const cls of Object.keys(ratios)) assetClasses.add(cls)
      }
      for (const cls of assetClasses) result[cls] = {}

      for (const acct of Object.values(acctMonthly)) {
        const ratios = accountAssetRatios[acct.institution]
        if (!ratios) {
          // No allocation data — put in "Other"
          if (!result['Other']) result['Other'] = {}
          for (const m of sortedMonths) {
            result['Other'][m] = (result['Other'][m] ?? 0) + (acct.data[m] ?? 0)
          }
          continue
        }
        for (const [cls, frac] of Object.entries(ratios)) {
          if (!result[cls]) result[cls] = {}
          for (const m of sortedMonths) {
            result[cls][m] = (result[cls][m] ?? 0) + (acct.data[m] ?? 0) * frac
          }
        }
      }
    }

    return { months: sortedMonths, series: result }
  }, [perfData, groupBy, accountAssetRatios])

  if (months.length === 0) return null

  const seriesNames = Object.keys(series).sort((a, b) => {
    // Sort by most recent value descending
    const lastMonth = months[months.length - 1]
    return (series[b][lastMonth] ?? 0) - (series[a][lastMonth] ?? 0)
  })

  const traces: Plotly.Data[] = seriesNames.map((name, i) => {
    const values = months.map((m) => series[name][m] ?? 0)

    if (valueMode === 'percent') {
      const totals = months.map((m) =>
        seriesNames.reduce((s, n) => s + (series[n][m] ?? 0), 0),
      )
      return {
        x: months,
        y: values.map((v, j) => totals[j] > 0 ? (v / totals[j]) * 100 : 0),
        name,
        type: 'scatter' as const,
        mode: 'none' as const,
        stackgroup: 'one',
        fillcolor: COLORS[i % COLORS.length] + '99',
        line: { width: 0 },
        hovertemplate: `${name}: %{y:.1f}%<extra></extra>`,
      }
    }
    return {
      x: months,
      y: values,
      name,
      type: 'scatter' as const,
      mode: 'none' as const,
      stackgroup: 'one',
      fillcolor: COLORS[i % COLORS.length] + '99',
      line: { width: 0 },
      hovertemplate: `${name}: $%{y:,.0f}<extra></extra>`,
    }
  })

  const groupOptions: { value: GroupBy; label: string }[] = [
    { value: 'institution', label: 'Institution' },
    { value: 'account', label: 'Account' },
    { value: 'asset_class', label: 'Asset Class (est.)' },
  ]

  return (
    <section className="chart-section">
      <div className="section-header">
        <h2>Allocation Over Time</h2>
        <div className="controls" style={{ display: 'flex', gap: 8 }}>
          <div className="time-range-selector">
            {groupOptions.map((opt) => (
              <button
                key={opt.value}
                className={`range-btn ${groupBy === opt.value ? 'active' : ''}`}
                onClick={() => setGroupBy(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="time-range-selector">
            <button
              className={`range-btn ${valueMode === 'percent' ? 'active' : ''}`}
              onClick={() => setValueMode('percent')}
            >
              %
            </button>
            <button
              className={`range-btn ${valueMode === 'absolute' ? 'active' : ''}`}
              onClick={() => setValueMode('absolute')}
            >
              $
            </button>
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
            ticksuffix: valueMode === 'percent' ? '%' : '',
            tickprefix: valueMode === 'absolute' ? '$' : '',
            hoverformat: valueMode === 'percent' ? '.1f' : ',.0f',
            range: valueMode === 'percent' ? [0, 100] : undefined,
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
        style={{ width: '100%', height: 380 }}
      />
      {groupBy === 'asset_class' && (
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, textAlign: 'center', marginTop: 4 }}>
          Estimated from current account allocations projected backward
        </p>
      )}
    </section>
  )
}
