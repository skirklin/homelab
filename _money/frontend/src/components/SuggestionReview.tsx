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
  const [rejectingId, setRejectingId] = useState<number | null>(null)
  const [feedbackText, setFeedbackText] = useState('')

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

  const handleRejectStart = useCallback((id: number) => {
    setRejectingId(id)
    setFeedbackText('')
  }, [])

  const handleRejectConfirm = useCallback(async () => {
    if (rejectingId == null) return
    setLoading((prev) => ({ ...prev, [rejectingId]: true }))
    try {
      await rejectSuggestion(rejectingId, feedbackText || undefined)
      setRejectingId(null)
      setFeedbackText('')
      refresh()
    } finally {
      setLoading((prev) => ({ ...prev, [rejectingId!]: false }))
    }
  }, [rejectingId, feedbackText, refresh])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    try {
      await generateSuggestions()
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
        <h2>category suggestions <span className="suggestion-badge">{suggestions.length}</span></h2>
        <div className="controls">
          <button
            className="toggle-btn"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? 'generating...' : 'generate more'}
          </button>
        </div>
      </div>
      <div className="suggestions-list">
        {suggestions.map((s) => {
          const isExpanded = expanded === s.id
          const isLoading = loading[s.id]
          const isRejecting = rejectingId === s.id
          return (
            <div key={s.id} className="suggestion-card">
              <div className="suggestion-header" onClick={() => setExpanded(isExpanded ? null : s.id)}>
                <div className="suggestion-info">
                  <code className="suggestion-pattern">{s.pattern}</code>
                  <span className="suggestion-arrow">&rarr;</span>
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
                    accept
                  </button>
                  <button
                    className="suggestion-reject"
                    onClick={(e) => { e.stopPropagation(); handleRejectStart(s.id) }}
                    disabled={isLoading}
                  >
                    reject
                  </button>
                </div>
              </div>
              {s.reasoning && !isRejecting && (
                <div className="suggestion-reasoning">{s.reasoning}</div>
              )}
              {isRejecting && (
                <div className="reject-feedback" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    className="reject-feedback-input"
                    placeholder="what's wrong? (e.g. 'kobo is a bookstore, not a subscription')"
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRejectConfirm() }}
                    autoFocus
                  />
                  <button className="suggestion-reject" onClick={handleRejectConfirm} disabled={isLoading}>
                    confirm
                  </button>
                  <button className="suggestion-reject" onClick={() => setRejectingId(null)}>
                    cancel
                  </button>
                </div>
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
                          <td className="acct">{m.current_category_path ?? 'uncategorized'}</td>
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
