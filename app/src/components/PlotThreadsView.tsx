import { useState, useMemo } from 'react';
import { useAnalysis } from '../context/AnalysisContext';
import type { PlotThreadView, PlotThreadEvent } from '../types/analysis';
import './PlotThreadsView.css';

type FilterStatus = 'all' | 'active' | 'resolved' | 'abandoned';

const ACTION_LABELS: Record<PlotThreadEvent['action'], string> = {
  introduced: 'Introduced',
  advanced: 'Advanced',
  complicated: 'Complicated',
  resolved: 'Resolved',
};

const ACTION_ICONS: Record<PlotThreadEvent['action'], string> = {
  introduced: '+',
  advanced: '>',
  complicated: '!',
  resolved: '=',
};

export function PlotThreadsView() {
  const { analysis, navigateToLocation, selectIssue } = useAnalysis();
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');

  const filteredThreads = useMemo(() => {
    if (!analysis) return [];
    if (filterStatus === 'all') return analysis.plotThreads;
    return analysis.plotThreads.filter(t => t.status === filterStatus);
  }, [analysis, filterStatus]);

  const selected = useMemo(() => {
    if (!selectedThread || !analysis) return null;
    return analysis.plotThreads.find(t => t.id === selectedThread) || null;
  }, [analysis, selectedThread]);

  const getIssuesForThread = (thread: PlotThreadView) => {
    if (!analysis) return [];
    return analysis.issues.filter(i => thread.issueIds.includes(i.id));
  };

  const getChunkTitle = (chunkId: string) => {
    if (!analysis) return chunkId;
    const chunk = analysis.chunks.find(c => c.id === chunkId);
    return chunk?.title || `Chunk ${chunkId}`;
  };

  if (!analysis) return null;

  return (
    <div className="threads-view">
      <div className="threads-sidebar">
        <div className="sidebar-header">
          <h2>Plot Threads ({filteredThreads.length})</h2>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
          >
            <option value="all">All ({analysis.plotThreads.length})</option>
            <option value="active">Active ({analysis.plotThreads.filter(t => t.status === 'active').length})</option>
            <option value="resolved">Resolved ({analysis.plotThreads.filter(t => t.status === 'resolved').length})</option>
            <option value="abandoned">Abandoned ({analysis.plotThreads.filter(t => t.status === 'abandoned').length})</option>
          </select>
        </div>
        <div className="thread-list">
          {filteredThreads.map(thread => (
            <div
              key={thread.id}
              className={`thread-item ${selectedThread === thread.id ? 'selected' : ''} ${thread.status}`}
              onClick={() => setSelectedThread(thread.id)}
            >
              <div className="thread-status-indicator" />
              <div className="thread-info">
                <span className="thread-name">{thread.name}</span>
                <div className="thread-meta">
                  <span className={`status-badge ${thread.status}`}>{thread.status}</span>
                  <span className="event-count">{thread.lifecycle.length} events</span>
                  {thread.issueIds.length > 0 && (
                    <span className="issue-count">{thread.issueIds.length} issues</span>
                  )}
                </div>
              </div>
            </div>
          ))}

          {filteredThreads.length === 0 && (
            <div className="no-threads">No plot threads match this filter</div>
          )}
        </div>
      </div>

      <div className="thread-detail">
        {selected ? (
          <ThreadDetail
            thread={selected}
            issues={getIssuesForThread(selected)}
            getChunkTitle={getChunkTitle}
            onNavigate={navigateToLocation}
            onIssueClick={(issueId) => {
              const issue = analysis.issues.find(i => i.id === issueId);
              if (issue) selectIssue(issue);
            }}
          />
        ) : (
          <div className="no-selection">
            Select a plot thread to view details
          </div>
        )}
      </div>
    </div>
  );
}

interface ThreadDetailProps {
  thread: PlotThreadView;
  issues: ReturnType<typeof Array.prototype.filter>;
  getChunkTitle: (chunkId: string) => string;
  onNavigate: (location: PlotThreadEvent['location']) => void;
  onIssueClick: (issueId: string) => void;
}

function ThreadDetail({ thread, issues, getChunkTitle, onNavigate, onIssueClick }: ThreadDetailProps) {
  return (
    <div className="detail-content">
      <div className="detail-header">
        <h2>{thread.name}</h2>
        <span className={`status-badge large ${thread.status}`}>{thread.status}</span>
      </div>

      <p className="thread-description">{thread.description}</p>

      <div className="lifecycle-section">
        <h3>Thread Lifecycle</h3>
        <div className="lifecycle-track">
          {thread.lifecycle.map((event, idx) => (
            <div
              key={idx}
              className={`lifecycle-event ${event.action}`}
              onClick={() => onNavigate(event.location)}
            >
              <div className="lifecycle-marker">
                <div className="lifecycle-dot">
                  <span className="action-icon">{ACTION_ICONS[event.action]}</span>
                </div>
                {idx < thread.lifecycle.length - 1 && <div className="lifecycle-line" />}
              </div>
              <div className="lifecycle-content">
                <div className="lifecycle-header">
                  <span className={`action-badge ${event.action}`}>
                    {ACTION_LABELS[event.action]}
                  </span>
                  <span className="lifecycle-source">{getChunkTitle(event.chunkId)}</span>
                </div>
                <p className="lifecycle-description">{event.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {issues.length > 0 && (
        <div className="issues-section">
          <h3>Related Issues ({issues.length})</h3>
          <div className="thread-issues">
            {issues.map((issue: any) => (
              <div
                key={issue.id}
                className={`issue-item ${issue.severity}`}
                onClick={() => onIssueClick(issue.id)}
              >
                <span className="issue-title">{issue.title}</span>
                <span className="issue-type">{issue.type.replace(/_/g, ' ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
