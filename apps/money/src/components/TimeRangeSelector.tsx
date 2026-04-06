export type TimeRange = '1M' | '3M' | '6M' | '1Y' | '5Y' | 'ALL'

const RANGES: TimeRange[] = ['1M', '3M', '6M', '1Y', '5Y', 'ALL']

export function getStartDate(range: TimeRange): string | undefined {
  if (range === 'ALL') return undefined
  const d = new Date()
  switch (range) {
    case '1M': d.setMonth(d.getMonth() - 1); break
    case '3M': d.setMonth(d.getMonth() - 3); break
    case '6M': d.setMonth(d.getMonth() - 6); break
    case '1Y': d.setFullYear(d.getFullYear() - 1); break
    case '5Y': d.setFullYear(d.getFullYear() - 5); break
  }
  return d.toISOString().slice(0, 10)
}

interface Props {
  value: TimeRange
  onChange: (range: TimeRange) => void
}

export function TimeRangeSelector({ value, onChange }: Props) {
  return (
    <div className="time-range-selector">
      {RANGES.map((r) => (
        <button
          key={r}
          className={`range-btn ${r === value ? 'active' : ''}`}
          onClick={() => onChange(r)}
        >
          {r}
        </button>
      ))}
    </div>
  )
}
