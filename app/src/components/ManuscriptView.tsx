import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useAnalysis } from '../context/AnalysisContext';
import type { ChunkWithText, TextLocation, IssueWithContext } from '../types/analysis';
import './ManuscriptView.css';

const CHUNKS_PER_PAGE = 5;

export function ManuscriptView() {
  const { analysis, highlightedLocation, selectIssue } = useAnalysis();
  const highlightRef = useRef<HTMLSpanElement>(null);
  const [visibleChunks, setVisibleChunks] = useState(CHUNKS_PER_PAGE);
  const contentRef = useRef<HTMLDivElement>(null);

  // Build a map of chunk ID -> issues that reference this chunk
  const issuesByChunk = useMemo(() => {
    if (!analysis) return new Map<string, IssueWithContext[]>();

    const map = new Map<string, IssueWithContext[]>();
    for (const issue of analysis.issues) {
      for (const evidence of issue.evidence) {
        const chunkId = evidence.location.chunkId;
        if (!map.has(chunkId)) {
          map.set(chunkId, []);
        }
        const issues = map.get(chunkId)!;
        if (!issues.find(i => i.id === issue.id)) {
          issues.push(issue);
        }
      }
    }
    return map;
  }, [analysis]);

  // Load more chunks when scrolling near bottom
  const handleScroll = useCallback(() => {
    if (!contentRef.current || !analysis) return;
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    if (scrollHeight - scrollTop - clientHeight < 500) {
      setVisibleChunks(prev => Math.min(prev + CHUNKS_PER_PAGE, analysis.chunks.length));
    }
  }, [analysis]);

  // Scroll to highlighted location when it changes
  useEffect(() => {
    if (highlightedLocation && analysis) {
      // Make sure the chunk containing the highlight is visible
      const chunkIndex = analysis.chunks.findIndex(c => c.id === highlightedLocation.chunkId);
      if (chunkIndex >= 0 && chunkIndex >= visibleChunks) {
        setVisibleChunks(chunkIndex + 1);
      }
      // Small delay to allow render before scrolling
      setTimeout(() => {
        if (highlightRef.current) {
          highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    }
  }, [highlightedLocation, analysis, visibleChunks]);

  if (!analysis) return null;

  const chunksToRender = analysis.chunks.slice(0, visibleChunks);
  const hasMore = visibleChunks < analysis.chunks.length;

  return (
    <div className="manuscript-view">
      <div className="manuscript-header">
        <h2>Manuscript</h2>
        <span className="chunk-count">{analysis.chunks.length} sections</span>
      </div>
      <div className="manuscript-content" ref={contentRef} onScroll={handleScroll}>
        {chunksToRender.map((chunk) => (
          <ChunkDisplay
            key={chunk.id}
            chunk={chunk}
            issues={issuesByChunk.get(chunk.id) || []}
            highlightedLocation={highlightedLocation}
            highlightRef={highlightRef}
            onIssueClick={selectIssue}
          />
        ))}
        {hasMore && (
          <button
            className="load-more-btn"
            onClick={() => setVisibleChunks(prev => Math.min(prev + CHUNKS_PER_PAGE, analysis.chunks.length))}
          >
            Load more ({analysis.chunks.length - visibleChunks} remaining)
          </button>
        )}
      </div>
    </div>
  );
}

interface ChunkDisplayProps {
  chunk: ChunkWithText;
  issues: IssueWithContext[];
  highlightedLocation: TextLocation | null;
  highlightRef: React.RefObject<HTMLSpanElement | null>;
  onIssueClick: (issue: IssueWithContext) => void;
}

const ChunkDisplay = React.memo(function ChunkDisplay({
  chunk,
  issues,
  highlightedLocation,
  highlightRef,
  onIssueClick
}: ChunkDisplayProps) {
  const isHighlightedChunk = highlightedLocation?.chunkId === chunk.id;

  // For performance, only compute highlights if this chunk has the active highlight
  // or has issues - otherwise just render plain text
  const hasHighlights = isHighlightedChunk || issues.length > 0;

  // Simple rendering for chunks without highlights
  if (!hasHighlights) {
    return (
      <div className="chunk-container">
        <div className="chunk-header">
          <span className="chunk-title">{chunk.title || `Section ${chunk.id}`}</span>
        </div>
        <div className="chunk-text">{chunk.text}</div>
      </div>
    );
  }

  // Build segments with highlights - only for chunks that need it
  const segments = (() => {
    const text = chunk.text;
    const textLength = text.length;

    // Collect all highlight ranges for this chunk (limit to 20 to prevent perf issues)
    const ranges: Array<{
      start: number;
      end: number;
      type: 'highlight' | 'issue';
      issue?: IssueWithContext;
    }> = [];

    // Add the main highlight if it's in this chunk
    if (isHighlightedChunk && highlightedLocation) {
      const start = Math.max(0, highlightedLocation.startOffset);
      const end = Math.min(textLength, highlightedLocation.endOffset);
      if (start < end && end > start) {
        ranges.push({ start, end, type: 'highlight' });
      }
    }

    // Add issue evidence highlights (limit to first 10 issues to prevent slowdown)
    const issuesToShow = issues.slice(0, 10);
    for (const issue of issuesToShow) {
      for (const evidence of issue.evidence) {
        if (evidence.location.chunkId === chunk.id) {
          const start = Math.max(0, evidence.location.startOffset);
          const end = Math.min(textLength, evidence.location.endOffset);
          if (start < end && end > start && ranges.length < 20) {
            ranges.push({ start, end, type: 'issue', issue });
          }
        }
      }
    }

    if (ranges.length === 0) {
      return [{ text, isHighlight: false, isIssue: false }];
    }

    // Sort ranges by start position
    ranges.sort((a, b) => a.start - b.start);

    // Build text segments
    const result: Array<{
      text: string;
      isHighlight: boolean;
      isIssue: boolean;
      issue?: IssueWithContext;
    }> = [];

    let pos = 0;
    for (const range of ranges) {
      if (range.start < pos) continue; // Skip overlapping ranges
      if (range.start >= textLength) break; // Safety check

      if (range.start > pos) {
        result.push({
          text: text.slice(pos, range.start),
          isHighlight: false,
          isIssue: false,
        });
      }

      const safeEnd = Math.min(range.end, textLength);
      if (safeEnd > range.start) {
        result.push({
          text: text.slice(range.start, safeEnd),
          isHighlight: range.type === 'highlight',
          isIssue: range.type === 'issue',
          issue: range.issue,
        });
      }
      pos = safeEnd;
    }

    if (pos < textLength) {
      result.push({
        text: text.slice(pos),
        isHighlight: false,
        isIssue: false,
      });
    }

    return result;
  })();

  return (
    <div className="chunk-container">
      <div className="chunk-header">
        <span className="chunk-title">{chunk.title || `Section ${chunk.id}`}</span>
        {issues.length > 0 && (
          <span className="chunk-issues">{issues.length} issue{issues.length !== 1 ? 's' : ''}</span>
        )}
      </div>
      <div className="chunk-text">
        {segments.map((segment, idx) => {
          if (segment.isHighlight) {
            return (
              <span key={idx} ref={highlightRef} className="text-highlight">
                {segment.text}
              </span>
            );
          }
          if (segment.isIssue && segment.issue) {
            return (
              <span
                key={idx}
                className={`text-issue ${segment.issue.severity}`}
                onClick={() => onIssueClick(segment.issue!)}
                title={segment.issue.title}
              >
                {segment.text}
              </span>
            );
          }
          return <span key={idx}>{segment.text}</span>;
        })}
      </div>
    </div>
  );
});
