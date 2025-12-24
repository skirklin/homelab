import { useState, useMemo, useEffect, useCallback } from 'react';
import { useAnalysis } from '../context/AnalysisContext';
import type { IssueWithContext, IssueType } from '../types/analysis';
import './IssuesView.css';

type FilterSeverity = 'all' | 'error' | 'warning' | 'info';
type FilterStatus = 'all' | 'open' | 'dismissed' | 'fixed';

const SEVERITY_ICONS: Record<IssueWithContext['severity'], string> = {
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

const TYPE_LABELS: Record<IssueType, string> = {
  timeline_inconsistency: 'Timeline',
  character_inconsistency: 'Character',
  fact_contradiction: 'Fact',
  unresolved_thread: 'Unresolved Thread',
  orphaned_payoff: 'Orphaned Payoff',
  missing_setup: 'Missing Setup',
  over_foreshadowed: 'Over-foreshadowed',
  under_foreshadowed: 'Under-foreshadowed',
  dropped_character: 'Dropped Character',
  dropped_object: 'Dropped Object',
  continuity_error: 'Continuity',
};

export function IssuesView() {
  const { analysis, selectedIssue, selectIssue, navigateToLocation, updateIssueStatus } = useAnalysis();
  const [filterSeverity, setFilterSeverity] = useState<FilterSeverity>('all');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('open');
  const [focusedIndex, setFocusedIndex] = useState<number>(0);

  const filteredIssues = useMemo(() => {
    if (!analysis) return [];
    return analysis.issues.filter(issue => {
      if (filterSeverity !== 'all' && issue.severity !== filterSeverity) return false;
      if (filterStatus !== 'all' && issue.status !== filterStatus) return false;
      return true;
    });
  }, [analysis, filterSeverity, filterStatus]);

  const groupedIssues = useMemo(() => {
    const groups: Record<string, IssueWithContext[]> = {
      error: [],
      warning: [],
      info: [],
    };
    for (const issue of filteredIssues) {
      groups[issue.severity].push(issue);
    }
    return groups;
  }, [filteredIssues]);

  // Keyboard navigation for issues list
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
      return;
    }

    if (filteredIssues.length === 0) return;

    if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      const newIndex = focusedIndex > 0 ? focusedIndex - 1 : filteredIssues.length - 1;
      setFocusedIndex(newIndex);
      selectIssue(filteredIssues[newIndex]);
    } else if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      const newIndex = focusedIndex < filteredIssues.length - 1 ? focusedIndex + 1 : 0;
      setFocusedIndex(newIndex);
      selectIssue(filteredIssues[newIndex]);
    } else if (e.key === 'Enter' && selectedIssue) {
      // Navigate to the first evidence location
      if (selectedIssue.evidence.length > 0) {
        e.preventDefault();
        navigateToLocation(selectedIssue.evidence[0].location);
      }
    } else if (e.key === 'd' && selectedIssue) {
      e.preventDefault();
      updateIssueStatus(selectedIssue.id, 'dismissed');
    } else if (e.key === 'f' && selectedIssue) {
      e.preventDefault();
      updateIssueStatus(selectedIssue.id, 'fixed');
    }
  }, [focusedIndex, filteredIssues, selectedIssue, selectIssue, navigateToLocation, updateIssueStatus]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Sync focused index with selected issue
  useEffect(() => {
    if (selectedIssue) {
      const idx = filteredIssues.findIndex(i => i.id === selectedIssue.id);
      if (idx !== -1 && idx !== focusedIndex) {
        setFocusedIndex(idx);
      }
    }
  }, [selectedIssue, filteredIssues, focusedIndex]);

  if (!analysis) return null;

  return (
    <div className="issues-view">
      <div className="issues-header">
        <h2>Issues ({filteredIssues.length})</h2>
        <div className="filters">
          <select
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value as FilterSeverity)}
          >
            <option value="all">All Severities</option>
            <option value="error">Errors ({analysis.summary.issuesBySeverity.error})</option>
            <option value="warning">Warnings ({analysis.summary.issuesBySeverity.warning})</option>
            <option value="info">Info ({analysis.summary.issuesBySeverity.info})</option>
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
          >
            <option value="all">All Status</option>
            <option value="open">Open</option>
            <option value="dismissed">Dismissed</option>
            <option value="fixed">Fixed</option>
          </select>
        </div>
      </div>

      <div className="issues-list">
        {(['error', 'warning', 'info'] as const).map(severity => {
          const issues = groupedIssues[severity];
          if (issues.length === 0) return null;

          return (
            <div key={severity} className="issues-group">
              <h3 className={`group-header ${severity}`}>
                {SEVERITY_ICONS[severity]} {severity.charAt(0).toUpperCase() + severity.slice(1)}s ({issues.length})
              </h3>
              {issues.map(issue => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  selected={selectedIssue?.id === issue.id}
                  onSelect={() => selectIssue(issue)}
                  onNavigate={(loc) => navigateToLocation(loc)}
                  onStatusChange={(status) => updateIssueStatus(issue.id, status)}
                />
              ))}
            </div>
          );
        })}

        {filteredIssues.length === 0 && (
          <div className="no-issues">
            No issues match your filters
          </div>
        )}
      </div>
    </div>
  );
}

interface IssueCardProps {
  issue: IssueWithContext;
  selected: boolean;
  onSelect: () => void;
  onNavigate: (location: IssueWithContext['evidence'][0]['location']) => void;
  onStatusChange: (status: IssueWithContext['status']) => void;
}

function IssueCard({ issue, selected, onSelect, onNavigate, onStatusChange }: IssueCardProps) {
  return (
    <div
      className={`issue-card ${issue.severity} ${selected ? 'selected' : ''} ${issue.status}`}
      onClick={onSelect}
    >
      <div className="issue-header">
        <span className="issue-type">{TYPE_LABELS[issue.type]}</span>
        <span className="issue-title">{issue.title}</span>
      </div>
      <p className="issue-description">{issue.description}</p>

      {issue.evidence.length > 0 && (
        <div className="issue-evidence">
          {issue.evidence.slice(0, 2).map((ev, idx) => (
            <div
              key={idx}
              className="evidence-item"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(ev.location);
              }}
            >
              <span className="evidence-quote">"{ev.quote}"</span>
              <span className="evidence-location">{ev.location.humanReadable}</span>
            </div>
          ))}
        </div>
      )}

      <div className="issue-actions">
        {issue.status === 'open' && (
          <>
            <button
              className="action-btn dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange('dismissed');
              }}
            >
              Dismiss
            </button>
            <button
              className="action-btn fix"
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange('fixed');
              }}
            >
              Mark Fixed
            </button>
          </>
        )}
        {issue.status !== 'open' && (
          <button
            className="action-btn reopen"
            onClick={(e) => {
              e.stopPropagation();
              onStatusChange('open');
            }}
          >
            Reopen
          </button>
        )}
      </div>
    </div>
  );
}
