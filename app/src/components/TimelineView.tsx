import { useMemo, useState } from 'react';
import { useAnalysis } from '../context/AnalysisContext';
import type { EventExtraction } from '../types/analysis';
import './TimelineView.css';

export function TimelineView() {
  const { analysis, navigateToLocation, selectIssue } = useAnalysis();
  const [showInconsistenciesOnly, setShowInconsistenciesOnly] = useState(false);

  // Build a map of all events from chunks
  const allEvents = useMemo(() => {
    if (!analysis) return [];

    const events: Array<EventExtraction & { chunkTitle: string }> = [];
    for (const chunk of analysis.chunks) {
      for (const event of chunk.extraction.events) {
        events.push({
          ...event,
          chunkTitle: chunk.title || `Chunk ${chunk.id}`,
        });
      }
    }
    return events;
  }, [analysis]);

  // Get timeline positions for events
  const positionedEvents = useMemo(() => {
    if (!analysis) return [];

    const positioned: Array<{
      event: EventExtraction & { chunkTitle: string };
      position: number;
      confidence: number;
      hasInconsistency: boolean;
    }> = [];

    for (const event of allEvents) {
      const timelineEvent = analysis.timeline.events.find(e => e.eventId === event.id);
      const hasInconsistency = analysis.timeline.inconsistencies.some(
        inc => inc.eventIds.includes(event.id)
      );

      if (showInconsistenciesOnly && !hasInconsistency) continue;

      positioned.push({
        event,
        position: timelineEvent?.position ?? 0,
        confidence: timelineEvent?.confidence ?? 0.5,
        hasInconsistency,
      });
    }

    return positioned.sort((a, b) => a.position - b.position);
  }, [analysis, allEvents, showInconsistenciesOnly]);

  const getInconsistencyForEvent = (eventId: string) => {
    if (!analysis) return null;
    return analysis.timeline.inconsistencies.find(inc => inc.eventIds.includes(eventId));
  };

  if (!analysis) return null;

  return (
    <div className="timeline-view">
      <div className="timeline-header">
        <h2>Timeline ({allEvents.length} events)</h2>
        <div className="timeline-controls">
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showInconsistenciesOnly}
              onChange={(e) => setShowInconsistenciesOnly(e.target.checked)}
            />
            Show inconsistencies only
          </label>
        </div>
      </div>

      {analysis.timeline.inconsistencies.length > 0 && (
        <div className="inconsistencies-summary">
          <h3>Timeline Issues ({analysis.timeline.inconsistencies.length})</h3>
          <div className="inconsistencies-list">
            {analysis.timeline.inconsistencies.map((inc, idx) => (
              <div
                key={idx}
                className="inconsistency-item"
                onClick={() => {
                  const issue = analysis.issues.find(i => i.id === inc.issueId);
                  if (issue) selectIssue(issue);
                }}
              >
                <span className="inc-description">{inc.description}</span>
                <span className="inc-events">{inc.eventIds.length} events involved</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis.timeline.spans.length > 0 && (
        <div className="spans-section">
          <h3>Time Spans</h3>
          <div className="spans-list">
            {analysis.timeline.spans.map(span => (
              <div key={span.id} className="span-item">
                <span className="span-name">{span.name}</span>
                {span.description && (
                  <span className="span-desc">{span.description}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="timeline-content">
        <div className="timeline-track">
          {positionedEvents.map(({ event, confidence, hasInconsistency }, idx) => {
            const inconsistency = hasInconsistency ? getInconsistencyForEvent(event.id) : null;

            return (
              <div
                key={event.id}
                className={`timeline-event ${event.precision} ${hasInconsistency ? 'has-inconsistency' : ''}`}
                style={{ opacity: 0.5 + confidence * 0.5 }}
                onClick={() => navigateToLocation(event.location)}
              >
                <div className="event-marker">
                  <div className="event-dot" />
                  {idx < positionedEvents.length - 1 && <div className="event-line" />}
                </div>
                <div className="event-content">
                  <div className="event-time">
                    <span className={`precision-badge ${event.precision}`}>
                      {event.precision}
                    </span>
                    <span className="time-marker">{event.timeMarker}</span>
                  </div>
                  <p className="event-description">{event.description}</p>
                  <div className="event-meta">
                    <span className="event-source">{event.chunkTitle}</span>
                    {event.characterIds.length > 0 && (
                      <span className="event-chars">
                        {event.characterIds.length} character{event.characterIds.length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  {inconsistency && (
                    <div
                      className="event-inconsistency"
                      onClick={(e) => {
                        e.stopPropagation();
                        const issue = analysis.issues.find(i => i.id === inconsistency.issueId);
                        if (issue) selectIssue(issue);
                      }}
                    >
                      Timeline issue: {inconsistency.description}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {positionedEvents.length === 0 && (
          <div className="no-events">
            {showInconsistenciesOnly
              ? 'No timeline inconsistencies found'
              : 'No events extracted from the manuscript'}
          </div>
        )}
      </div>
    </div>
  );
}
