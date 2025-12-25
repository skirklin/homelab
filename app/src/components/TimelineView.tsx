import { useMemo, useState } from 'react';
import { useAnalysis } from '../context/AnalysisContext';
import type { TimelineEvent, TimeAnchor, EntityTimeline } from '../types/analysis';
import './TimelineView.css';

type ViewMode = 'chronological' | 'entity' | 'chapter';

export function TimelineView() {
  const { analysis, navigateToChunk } = useAnalysis();
  const [viewMode, setViewMode] = useState<ViewMode>('chronological');
  const [selectedAnchor, setSelectedAnchor] = useState<number | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  // Filter events by selected time anchor (day offset)
  const filteredEvents = useMemo(() => {
    if (!analysis) return [];

    const events = analysis.timeline.globalEvents;
    if (selectedAnchor === null) return events;

    // Filter to events matching the selected day offset
    return events.filter(e => {
      const match = e.normalizedTime.match(/Day\s+(-?\d+)/i);
      if (match) {
        return parseInt(match[1]) === selectedAnchor;
      }
      return false;
    });
  }, [analysis, selectedAnchor]);

  // Group events by chapter
  const eventsByChapter = useMemo(() => {
    if (!analysis) return new Map<string, TimelineEvent[]>();

    const groups = new Map<string, TimelineEvent[]>();
    for (const event of filteredEvents) {
      const chapter = event.chapter || 'Unknown';
      if (!groups.has(chapter)) {
        groups.set(chapter, []);
      }
      groups.get(chapter)!.push(event);
    }
    return groups;
  }, [analysis, filteredEvents]);

  // Get the selected entity timeline
  const selectedEntityTimeline = useMemo(() => {
    if (!analysis || !selectedEntityId) return null;
    return analysis.timeline.entityTimelines.find(et => et.entityId === selectedEntityId) || null;
  }, [analysis, selectedEntityId]);

  const handleEventClick = (event: TimelineEvent) => {
    if (event.chunkId) {
      navigateToChunk(event.chunkId);
    }
  };

  if (!analysis) return null;

  const { timeline } = analysis;
  const totalEvents = timeline.globalEvents.length;
  const characterTimelines = timeline.entityTimelines.filter(et => et.entityType === 'character');
  const locationTimelines = timeline.entityTimelines.filter(et => et.entityType === 'location');

  return (
    <div className="timeline-view">
      <div className="timeline-header">
        <h2>Timeline ({totalEvents} events)</h2>
        <div className="timeline-controls">
          <label className="control-label">
            View:
            <select
              value={viewMode}
              onChange={(e) => {
                setViewMode(e.target.value as ViewMode);
                setSelectedEntityId(null);
              }}
            >
              <option value="chronological">Chronological</option>
              <option value="entity">By Entity</option>
              <option value="chapter">By Chapter</option>
            </select>
          </label>
        </div>
      </div>

      {/* Anchor point description */}
      {timeline.anchorPoint && (
        <div className="anchor-point">
          <span className="anchor-point-label">Day 0:</span>
          <span className="anchor-point-desc">{timeline.anchorPoint}</span>
        </div>
      )}

      {/* Time anchor chips for filtering */}
      {timeline.timeAnchors.length > 0 && viewMode !== 'entity' && (
        <div className="anchors-section">
          <h3>Time Period</h3>
          <div className="anchors-list">
            <button
              className={`anchor-chip ${selectedAnchor === null ? 'selected' : ''}`}
              onClick={() => setSelectedAnchor(null)}
            >
              All
            </button>
            {timeline.timeAnchors
              .sort((a, b) => a.dayOffset - b.dayOffset)
              .map((anchor: TimeAnchor) => (
                <button
                  key={anchor.id}
                  className={`anchor-chip ${selectedAnchor === anchor.dayOffset ? 'selected' : ''}`}
                  onClick={() => setSelectedAnchor(
                    selectedAnchor === anchor.dayOffset ? null : anchor.dayOffset
                  )}
                  title={anchor.description || undefined}
                >
                  {anchor.name}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Entity selector for entity view */}
      {viewMode === 'entity' && (
        <div className="entity-selector">
          {characterTimelines.length > 0 && (
            <div className="entity-group">
              <h3>Characters</h3>
              <div className="entity-chips">
                {characterTimelines.map((et: EntityTimeline) => (
                  <button
                    key={et.entityId}
                    className={`entity-chip ${selectedEntityId === et.entityId ? 'selected' : ''}`}
                    onClick={() => setSelectedEntityId(
                      selectedEntityId === et.entityId ? null : et.entityId
                    )}
                  >
                    {et.entityName}
                    <span className="entity-count">{et.events.length}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {locationTimelines.length > 0 && (
            <div className="entity-group">
              <h3>Locations</h3>
              <div className="entity-chips">
                {locationTimelines.map((et: EntityTimeline) => (
                  <button
                    key={et.entityId}
                    className={`entity-chip location ${selectedEntityId === et.entityId ? 'selected' : ''}`}
                    onClick={() => setSelectedEntityId(
                      selectedEntityId === et.entityId ? null : et.entityId
                    )}
                  >
                    {et.entityName}
                    <span className="entity-count">{et.events.length}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="timeline-content">
        {/* Chronological view - all events in order */}
        {viewMode === 'chronological' && (
          <div className="timeline-track">
            {filteredEvents.map((event, idx) => (
              <TimelineEventCard
                key={event.eventId}
                event={event}
                showConnector={idx < filteredEvents.length - 1}
                onClick={() => handleEventClick(event)}
              />
            ))}
          </div>
        )}

        {/* Entity view - show selected entity's timeline */}
        {viewMode === 'entity' && (
          <>
            {!selectedEntityId && (
              <div className="entity-prompt">
                Select a character or location above to see their timeline
              </div>
            )}
            {selectedEntityTimeline && (
              <div className="entity-timeline">
                <div className="entity-timeline-header">
                  <h3>{selectedEntityTimeline.entityName}'s Timeline</h3>
                  <span className="event-count">
                    {selectedEntityTimeline.events.length} events
                  </span>
                </div>
                <div className="timeline-track">
                  {selectedEntityTimeline.events.map((event, idx) => (
                    <TimelineEventCard
                      key={event.eventId}
                      event={event}
                      showConnector={idx < selectedEntityTimeline.events.length - 1}
                      onClick={() => handleEventClick(event)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Chapter view - grouped by chapter */}
        {viewMode === 'chapter' && (
          <div className="timeline-grouped">
            {Array.from(eventsByChapter.entries()).map(([chapter, events]) => (
              <div key={chapter} className="timeline-group">
                <h3 className="group-header">{chapter}</h3>
                <div className="timeline-track">
                  {events.map((event, idx) => (
                    <TimelineEventCard
                      key={event.eventId}
                      event={event}
                      showConnector={idx < events.length - 1}
                      onClick={() => handleEventClick(event)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {totalEvents === 0 && (
          <div className="no-events">
            No events extracted from the manuscript
          </div>
        )}
      </div>
    </div>
  );
}

interface TimelineEventCardProps {
  event: TimelineEvent;
  showConnector: boolean;
  onClick: () => void;
}

function TimelineEventCard({ event, showConnector, onClick }: TimelineEventCardProps) {
  return (
    <div
      className={`timeline-event ${event.isFlashback ? 'flashback' : ''}`}
      onClick={onClick}
    >
      <div className="event-marker">
        <div className="event-dot" />
        {showConnector && <div className="event-line" />}
      </div>
      <div className="event-content">
        <div className="event-time">
          <span className="time-normalized">{event.normalizedTime}</span>
          {event.originalTimeMarker && event.originalTimeMarker !== event.normalizedTime && (
            <span className="time-original">"{event.originalTimeMarker}"</span>
          )}
          {event.isFlashback && (
            <span className="flashback-badge">Flashback</span>
          )}
        </div>
        <p className="event-description">{event.description}</p>
        <div className="event-meta">
          <span className="event-source">{event.chapter}</span>
          {event.location && (
            <span className="event-location">{event.location}</span>
          )}
          {event.characterIds.length > 0 && (
            <span className="event-chars">
              {event.characterIds.length} character{event.characterIds.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
