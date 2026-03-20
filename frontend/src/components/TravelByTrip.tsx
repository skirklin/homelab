import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { TripSummary } from '../api'
import { fetchTravelTrips } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return ''
  const s = new Date(start + 'T12:00:00')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const startStr = `${months[s.getMonth()]} ${s.getDate()}`
  if (!end || start === end) return startStr
  const e = new Date(end + 'T12:00:00')
  if (s.getMonth() === e.getMonth()) return `${startStr}–${e.getDate()}`
  return `${startStr} – ${months[e.getMonth()]} ${e.getDate()}`
}

const THEME = {
  cardBg: '#1e1e3f',
  border: 'rgba(255,255,255,0.1)',
  textMuted: 'rgba(255,255,255,0.4)',
  text: 'rgba(255,255,255,0.7)',
  grid: 'rgba(255,255,255,0.06)',
}

export function TravelByTrip() {
  const [trips, setTrips] = useState<TripSummary[]>([])
  const chartRef = useRef<HTMLDivElement | null>(null)
  const echartsRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    fetchTravelTrips().then(setTrips)
  }, [])

  useEffect(() => {
    if (!chartRef.current) return
    echartsRef.current = echarts.init(chartRef.current)
    const handleResize = () => echartsRef.current?.resize()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      echartsRef.current?.dispose()
    }
  }, [])

  useEffect(() => {
    if (!echartsRef.current || trips.length === 0) return

    const chartTrips = trips
      .filter((t) => t.name !== 'Other Travel' && Math.abs(t.total) > 50)
      .reverse()

    const labels = chartTrips.map(
      (t) => `${t.name}  ${formatDateRange(t.start, t.end)}`,
    )
    const values = chartTrips.map((t) => Math.abs(t.total))
    const colors = chartTrips.map(
      (_, i) => `hsl(${200 + i * 11}, 65%, 60%)`,
    )

    echartsRef.current.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: THEME.cardBg,
        borderColor: THEME.border,
        textStyle: { color: THEME.text, fontSize: 12 },
        formatter: (params: echarts.DefaultLabelFormatterCallbackParams[]) => {
          if (!Array.isArray(params) || params.length === 0) return ''
          const p = params[0]
          const trip = chartTrips[chartTrips.length - 1 - (p.dataIndex as number)]
          if (!trip) return ''
          const days = trip.duration_days ? `${trip.duration_days}d` : ''
          return `<b>${trip.name}</b><br/>
            ${formatDateRange(trip.start, trip.end)} ${days}<br/>
            ${fmtDollar(p.value as number)} · ${trip.transaction_count} transactions`
        },
      },
      grid: {
        left: 180,
        right: 30,
        top: 10,
        bottom: 10,
      },
      xAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: {
          color: THEME.textMuted,
          fontSize: 11,
          formatter: (v: number) => fmtDollar(v),
        },
        splitLine: { lineStyle: { color: THEME.grid } },
      },
      yAxis: {
        type: 'category',
        data: labels,
        axisLine: { lineStyle: { color: THEME.grid } },
        axisLabel: { color: THEME.text, fontSize: 11, width: 170, overflow: 'truncate' },
      },
      series: [{
        type: 'bar',
        data: values,
        itemStyle: {
          color: (params: { dataIndex: number }) => colors[params.dataIndex],
          borderRadius: [0, 4, 4, 0],
        },
        barMaxWidth: 24,
        emphasis: {
          itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' },
        },
      }],
      animationDuration: 500,
      animationEasing: 'cubicOut',
    }, true)
  }, [trips])

  if (trips.length === 0) return null

  const totalSpent = trips.reduce((s, t) => s + t.total, 0)
  const namedTrips = trips.filter((t) => t.name !== 'Other Travel')
  const otherTravel = trips.find((t) => t.name === 'Other Travel')

  const chartHeight = Math.max(300, namedTrips.filter((t) => Math.abs(t.total) > 50).length * 30)

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>Travel by Trip</h2>
          <p style={{ color: THEME.textMuted, margin: '4px 0 8px', fontSize: 13 }}>
            Spending matched to calendar trips
          </p>
          <div className="metric-row">
            <span className="metric negative">
              <span className="metric-label">Total Travel</span>
              <span className="metric-value">{fmtDollar(totalSpent)}</span>
            </span>
            <span className="metric">
              <span className="metric-label">Trips</span>
              <span className="metric-value">{namedTrips.length}</span>
            </span>
          </div>
        </div>
      </div>
      <div ref={chartRef} style={{ width: '100%', height: chartHeight }} />
      {otherTravel && otherTravel.transaction_count > 0 && (
        <p style={{ color: THEME.textMuted, fontSize: 11, marginTop: 4, textAlign: 'right' }}>
          + {fmtDollar(otherTravel.total)} in {otherTravel.transaction_count} unmatched transactions
        </p>
      )}
    </section>
  )
}
