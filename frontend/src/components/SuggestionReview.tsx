import { useCallback, useEffect, useState } from 'react'
import type { Suggestion } from '../api'
import { fetchSuggestions, acceptSuggestion, rejectSuggestion, generateSuggestions } from '../api'

const fmtDollar = (v: number) =>
  `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function SuggestionReview({ onRulesChanged }: { onRulesChanged?: () => void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [loading, setLoading] = useState<Record<number, boolean>>({})
  const [generating, setGenerating] = useState(false)

  const refresh = useCallback(() => {
    fetchSuggestions().then(setSuggestions)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleAccept = useCallback(async (id: number) => {
    setLoading((prev) => ({ ...prev, [id]: true }))
    try {
      await acceptSuggestion(id)
      refresh()
      onRulesChanged?.()
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }))
    }
  }, [refresh, onRulesChanged])

  const handleReject = useCallback(async (id: number) => {
    setLoading((prev) => ({ ...prev, [id]: true }))
    try {
      await rejectSuggestion(id)
      refresh()
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }))
    }
  }, [refresh])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    try {
      await generateSuggestions()
      // Poll for results since generation is async
      setTimeout(refresh, 5000)
      setTimeout(refresh, 15000)
      setTimeout(refresh, 30000)
    } finally {
      setTimeout(() => setGenerating(false), 30000)
    }
  }, [refresh])

  if (suggestions.length === 0) return null

  return (
    <section className="chart-section suggestions-section">
      <div className="section-header">
        <h2>Category Suggestions <span className="suggestion-badge">{suggestions.length}</span></h2>
        <div className="controls">
          <button
            className="toggle-btn"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? 'Generating...' : 'Generate More'}
          </button>
        </div>
      </div>
      <div className="suggestions-list">
        {suggestions.map((s) => {
          const isExpanded = expanded === s.id
          const isLoading = loading[s.id]
          return (
            <div key={s.id} className="suggestion-card">
              <div className="suggestion-header" onClick={() => setExpanded(isExpanded ? null : s.id)}>
                <div className="suggestion-info">
                  <code className="suggestion-pattern">{s.pattern}</code>
                  <span className="suggestion-arrow">→</span>
                  <span className="suggestion-path">{s.category_path}</span>
                  <span className="suggestion-count">{s.matches.length} transaction{s.matches.length !== 1 ? 's' : ''}</span>
                  {s.confidence != null && (
                    <span className={`suggestion-confidence ${s.confidence >= 0.8 ? 'high' : s.confidence >= 0.5 ? 'med' : 'low'}`}>
                      {Math.round(s.confidence * 100)}%
                    </span>
                  )}
                </div>
                <div className="suggestion-actions">
                  <button
                    className="suggestion-accept"
                    onClick={(e) => { e.stopPropagation(); handleAccept(s.id) }}
                    disabled={isLoading}
                  >
                    Accept
                  </button>
                  <button
                    className="suggestion-reject"
                    onClick={(e) => { e.stopPropagation(); handleReject(s.id) }}
                    disabled={isLoading}
                  >
                    Reject
                  </button>
                </div>
              </div>
              {s.reasoning && (
                <div className="suggestion-reasoning">{s.reasoning}</div>
              )}
              {isExpanded && (
                <div className="suggestion-matches">
                  <table className="txn-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Description</th>
                        <th>Current</th>
                        <th className="right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.matches.map((m) => (
                        <tr key={m.id}>
                          <td className="date">{m.date}</td>
                          <td className="desc">{m.description}</td>
                          <td className="acct">{m.current_category_path ?? 'Uncategorized'}</td>
                          <td className={`amount right ${m.amount >= 0 ? 'positive' : 'negative'}`}>
                            {fmtDollar(m.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
