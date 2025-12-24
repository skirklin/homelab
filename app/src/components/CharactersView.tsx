import { useState, useMemo, useCallback, useEffect } from 'react';
import { useAnalysis } from '../context/AnalysisContext';
import type { CharacterEntity, ChunkWithText, EventExtraction } from '../types/analysis';
import './CharactersView.css';

export function CharactersView() {
  const { analysis, navigateToLocation, selectIssue } = useAnalysis();
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'mentions' | 'issues'>('mentions');
  const [focusedIndex, setFocusedIndex] = useState<number>(0);

  const sortedCharacters = useMemo(() => {
    if (!analysis) return [];
    const chars = [...analysis.entities.characters];

    switch (sortBy) {
      case 'name':
        return chars.sort((a, b) => a.name.localeCompare(b.name));
      case 'mentions':
        return chars.sort((a, b) => b.stats.totalMentions - a.stats.totalMentions);
      case 'issues':
        return chars.sort((a, b) => b.issueIds.length - a.issueIds.length);
      default:
        return chars;
    }
  }, [analysis, sortBy]);

  const selected = useMemo(() => {
    if (!selectedCharacter || !analysis) return null;
    return analysis.entities.characters.find(c => c.id === selectedCharacter) || null;
  }, [analysis, selectedCharacter]);

  const getIssuesForCharacter = (character: CharacterEntity) => {
    if (!analysis) return [];
    return analysis.issues.filter(i => character.issueIds.includes(i.id));
  };

  // Build a map of event ID -> event for quick lookup
  const eventsMap = useMemo(() => {
    if (!analysis) return new Map<string, EventExtraction>();
    const map = new Map<string, EventExtraction>();
    for (const chunk of analysis.chunks) {
      for (const event of chunk.extraction.events) {
        map.set(event.id, event);
      }
    }
    return map;
  }, [analysis]);

  // Keyboard navigation for character list
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
      return;
    }

    if (sortedCharacters.length === 0) return;

    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      const newIndex = focusedIndex > 0 ? focusedIndex - 1 : sortedCharacters.length - 1;
      setFocusedIndex(newIndex);
      setSelectedCharacter(sortedCharacters[newIndex].id);
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      const newIndex = focusedIndex < sortedCharacters.length - 1 ? focusedIndex + 1 : 0;
      setFocusedIndex(newIndex);
      setSelectedCharacter(sortedCharacters[newIndex].id);
    } else if (e.key === 'Enter' && selected) {
      // Navigate to the first appearance
      if (selected.appearances.length > 0 && selected.appearances[0].mentions.length > 0) {
        e.preventDefault();
        navigateToLocation(selected.appearances[0].mentions[0]);
      }
    }
  }, [focusedIndex, sortedCharacters, selected, navigateToLocation]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Sync focused index with selected character
  useEffect(() => {
    if (selectedCharacter) {
      const idx = sortedCharacters.findIndex(c => c.id === selectedCharacter);
      if (idx !== -1 && idx !== focusedIndex) {
        setFocusedIndex(idx);
      }
    }
  }, [selectedCharacter, sortedCharacters, focusedIndex]);

  if (!analysis) return null;

  return (
    <div className="characters-view">
      <div className="characters-sidebar">
        <div className="sidebar-header">
          <h2>Characters ({sortedCharacters.length})</h2>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="mentions">Most mentions</option>
            <option value="issues">Most issues</option>
            <option value="name">Alphabetical</option>
          </select>
        </div>
        <div className="character-list">
          {sortedCharacters.map(char => (
            <div
              key={char.id}
              className={`character-item ${selectedCharacter === char.id ? 'selected' : ''} ${char.issueIds.length > 0 ? 'has-issues' : ''}`}
              onClick={() => setSelectedCharacter(char.id)}
            >
              <span className="char-name">{char.name}</span>
              <div className="char-stats">
                <span className="stat">{char.stats.totalMentions} mentions</span>
                {char.issueIds.length > 0 && (
                  <span className="stat issues">{char.issueIds.length} issues</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="character-detail">
        {selected ? (
          <CharacterDetail
            character={selected}
            issues={getIssuesForCharacter(selected)}
            characters={analysis.entities.characters}
            chunks={analysis.chunks}
            eventsMap={eventsMap}
            onNavigate={navigateToLocation}
            onSelectCharacter={setSelectedCharacter}
            onIssueClick={(issueId) => {
              const issue = analysis.issues.find(i => i.id === issueId);
              if (issue) selectIssue(issue);
            }}
          />
        ) : (
          <div className="no-selection">
            Select a character to view details
          </div>
        )}
      </div>
    </div>
  );
}

interface CharacterDetailProps {
  character: CharacterEntity;
  issues: ReturnType<typeof Array.prototype.filter>;
  characters: CharacterEntity[];
  chunks: ChunkWithText[];
  eventsMap: Map<string, EventExtraction>;
  onNavigate: (location: CharacterEntity['attributes'][0]['location']) => void;
  onSelectCharacter: (characterId: string) => void;
  onIssueClick: (issueId: string) => void;
}

function CharacterDetail({ character, issues, characters, chunks, eventsMap, onNavigate, onSelectCharacter, onIssueClick }: CharacterDetailProps) {
  // Helper to get character name from ID
  const getCharacterName = useCallback((id: string) => {
    const char = characters.find(c => c.id === id);
    return char?.name ?? id;
  }, [characters]);

  // Helper to get chunk title from ID
  const getChunkTitle = useCallback((chunkId: string) => {
    const chunk = chunks.find(c => c.id === chunkId);
    return chunk?.title ?? chunkId;
  }, [chunks]);

  // Get events for this character
  const characterEvents = useMemo(() => {
    return (character.eventIds || [])
      .map(id => eventsMap.get(id))
      .filter((e): e is EventExtraction => e !== undefined);
  }, [character.eventIds, eventsMap]);
  return (
    <div className="detail-content">
      <div className="detail-header">
        <h2>{character.name}</h2>
        {character.aliases.length > 0 && (
          <div className="aliases">
            Also known as: {character.aliases.join(', ')}
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3>Overview</h3>
        <div className="stats-grid">
          <div className="stat-item">
            <span className="stat-value">{character.stats.totalMentions}</span>
            <span className="stat-label">Total mentions</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{character.stats.presentInChunks}</span>
            <span className="stat-label">Chapters present</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{character.relationships.length}</span>
            <span className="stat-label">Relationships</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{characterEvents.length}</span>
            <span className="stat-label">Events</span>
          </div>
        </div>
      </div>

      {characterEvents.length > 0 && (
        <div className="detail-section">
          <h3>Timeline ({characterEvents.length} events)</h3>
          <div className="character-timeline">
            {characterEvents.map((event, idx) => (
              <div
                key={idx}
                className="timeline-event clickable"
                onClick={() => onNavigate(event.location)}
              >
                <div className="event-marker" />
                <div className="event-content">
                  <div className="event-description">{event.description}</div>
                  <div className="event-meta">
                    <span className="event-time">{event.timeMarker}</span>
                    <span className="event-location">{getChunkTitle(event.location.chunkId)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {character.attributes.length > 0 && (
        <div className="detail-section">
          <h3>Attributes</h3>
          <div className="attributes-list">
            {character.attributes.map((attr, idx) => (
              <div
                key={idx}
                className={`attribute-item ${attr.conflictsWith ? 'conflicting' : ''}`}
                onClick={() => attr.location && onNavigate(attr.location)}
              >
                <span className="attr-key">{attr.attribute ?? 'unknown'}:</span>
                <span className="attr-value">{attr.value ?? 'unknown'}</span>
                {attr.conflictsWith && (
                  <span
                    className="conflict-badge"
                    onClick={(e) => {
                      e.stopPropagation();
                      onIssueClick(attr.conflictsWith!.issueId);
                    }}
                  >
                    Conflicts
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {character.relationships.length > 0 && (
        <div className="detail-section">
          <h3>Relationships</h3>
          <div className="relationships-list">
            {character.relationships.map((rel, idx) => {
              const sharedEvents = (rel.sharedEventIds || [])
                .map(id => eventsMap.get(id))
                .filter((e): e is EventExtraction => e !== undefined);

              return (
                <div key={idx} className="relationship-item-block">
                  <div className="relationship-header-row">
                    <span
                      className="rel-target clickable"
                      onClick={() => onSelectCharacter(rel.targetCharacterId)}
                    >
                      {rel.targetName || getCharacterName(rel.targetCharacterId)}
                    </span>
                    <span className="rel-type">{rel.relationship}</span>
                  </div>
                  {sharedEvents.length > 0 && (
                    <div className="shared-events">
                      {sharedEvents.slice(0, 3).map((event, evIdx) => (
                        <div
                          key={evIdx}
                          className="shared-event clickable"
                          onClick={() => onNavigate(event.location)}
                        >
                          {event.description}
                        </div>
                      ))}
                      {sharedEvents.length > 3 && (
                        <div className="more-events">
                          +{sharedEvents.length - 3} more events
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {character.appearances.length > 0 && (
        <div className="detail-section">
          <h3>Appearances ({character.appearances.length})</h3>
          <div className="appearances-list">
            {character.appearances.map((app, idx) => (
              <div
                key={idx}
                className="appearance-item clickable"
                onClick={() => app.mentions.length > 0 && onNavigate(app.mentions[0])}
              >
                <span className={`app-role ${app.role}`}>{app.role}</span>
                <span className="app-chunk">{getChunkTitle(app.chunkId)}</span>
                <span className="app-mentions">{app.mentions.length} mention{app.mentions.length !== 1 ? 's' : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {issues.length > 0 && (
        <div className="detail-section issues-section">
          <h3>Related Issues ({issues.length})</h3>
          <div className="character-issues">
            {issues.map((issue: any) => (
              <div
                key={issue.id}
                className={`issue-item ${issue.severity}`}
                onClick={() => onIssueClick(issue.id)}
              >
                <span className="issue-title">{issue.title}</span>
                <span className="issue-type">{issue.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
