import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'
import type { CollectionInfo, CollectionMonthSummary } from '../api'
import { fetchCollections, fetchCollectionByMonth } from '../api'

const fmtDollar = (v: number) =>
  `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

const THEME = {
  cardBg: '#1e1e3f',
  border: 'rgba(255,255,255,0.1)',
  textMuted: 'rgba(255,255,255,0.4)',
  text: 'rgba(255,255,255,0.7)',
  grid: 'rgba(255,255,255,0.06)',
}

function CollectionDetail({ collection }: { collection: CollectionInfo }) {
  const [months, setMonths] = useState<CollectionMonthSummary[]>([])
  const chartRef = useRef<HTMLDivElement | null>(null)
  const echartsRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    fetchCollectionByMonth(collection.id).then(setMonths)
  }, [collection.id])

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
    if (!echartsRef.current || months.length === 0) return

    echartsRef.current.setOption({
      tooltip: {
        trigger: 'axis',
        backgroundColor: THEME.cardBg,
        borderColor: THEME.border,
        textStyle: { color: THEME.text, fontSize: 12 },
        formatter: (params: echarts.DefaultLabelFormatterCallbackParams[]) => {
          if (!Array.isArray(params) || params.length === 0) return ''
          const p = params[0]
          return `<b>${p.axisValueLabel}</b><br/>${fmtDollar(p.value as number)}`
        },
      },
      grid: { left: 60, right: 20, top: 10, bottom: 30 },
      xAxis: {
        type: 'category',
        data: months.map((m) => m.month),
        axisLine: { lineStyle: { color: THEME.grid } },
        axisLabel: { color: THEME.textMuted, fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisLabel: {
          color: THEME.textMuted,
          fontSize: 11,
          formatter: (v: number) => fmtDollar(v),
        },
        splitLine: { lineStyle: { color: THEME.grid } },
      },
      series: [{
        type: 'bar',
        data: months.map((m) => Math.abs(m.total)),
        itemStyle: { color: '#818cf8', borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 40,
      }],
      animationDuration: 400,
    }, true)
  }, [months])

  const totalSpent = months.reduce((s, m) => s + m.total, 0)

  return (
    <section className="chart-section">
      <div className="section-header">
        <div>
          <h2>{collection.label}</h2>
          <p style={{ color: THEME.textMuted, margin: '4px 0 8px', fontSize: 13 }}>
            {collection.description}
          </p>
          <div className="metric-row">
            <span className="metric negative">
              <span className="metric-label">Total</span>
              <span className="metric-value">{fmtDollar(totalSpent)}</span>
            </span>
          </div>
        </div>
      </div>
      {months.length > 0 && (
        <div ref={chartRef} style={{ width: '100%', height: 200 }} />
      )}
    </section>
  )
}

export function SpendingCollections() {
  const [collections, setCollections] = useState<CollectionInfo[]>([])

  useEffect(() => {
    fetchCollections().then(setCollections)
  }, [])

  if (collections.length === 0) return null

  return (
    <>
      {collections.map((c) => (
        <CollectionDetail key={c.id} collection={c} />
      ))}
    </>
  )
}
