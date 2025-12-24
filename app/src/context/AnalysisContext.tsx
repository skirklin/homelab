import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { AnalysisOutput, IssueWithContext, TextLocation } from '../types/analysis';

export type TabId = 'issues' | 'manuscript' | 'characters' | 'timeline' | 'threads';

interface AnalysisContextType {
  /** The loaded analysis data */
  analysis: AnalysisOutput | null;
  /** Loading state */
  loading: boolean;
  /** Error message if load failed */
  error: string | null;
  /** Load analysis from a JSON file */
  loadFromFile: (file: File) => Promise<void>;
  /** Load analysis from a URL */
  loadFromUrl: (url: string) => Promise<void>;
  /** Currently selected issue */
  selectedIssue: IssueWithContext | null;
  /** Select an issue */
  selectIssue: (issue: IssueWithContext | null) => void;
  /** Currently highlighted location (for manuscript view) */
  highlightedLocation: TextLocation | null;
  /** Highlight a location */
  highlightLocation: (location: TextLocation | null) => void;
  /** Navigate to a location in the manuscript */
  navigateToLocation: (location: TextLocation) => void;
  /** Update issue status */
  updateIssueStatus: (issueId: string, status: IssueWithContext['status']) => void;
  /** Active tab */
  activeTab: TabId;
  /** Set active tab */
  setActiveTab: (tab: TabId) => void;
}

const AnalysisContext = createContext<AnalysisContextType | null>(null);

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [analysis, setAnalysis] = useState<AnalysisOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<IssueWithContext | null>(null);
  const [highlightedLocation, setHighlightedLocation] = useState<TextLocation | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('issues');

  const loadFromFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text) as AnalysisOutput;
      if (data.schemaVersion !== '1.0') {
        throw new Error(`Unsupported schema version: ${data.schemaVersion}`);
      }
      setAnalysis(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analysis');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFromUrl = useCallback(async (url: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }
      const data = await response.json() as AnalysisOutput;
      if (data.schemaVersion !== '1.0') {
        throw new Error(`Unsupported schema version: ${data.schemaVersion}`);
      }
      setAnalysis(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analysis');
    } finally {
      setLoading(false);
    }
  }, []);

  const selectIssue = useCallback((issue: IssueWithContext | null) => {
    setSelectedIssue(issue);
    if (issue && issue.evidence.length > 0) {
      setHighlightedLocation(issue.evidence[0].location);
    }
  }, []);

  const highlightLocation = useCallback((location: TextLocation | null) => {
    setHighlightedLocation(location);
  }, []);

  const navigateToLocation = useCallback((location: TextLocation) => {
    setHighlightedLocation(location);
    setActiveTab('manuscript');
  }, []);

  const updateIssueStatus = useCallback((issueId: string, status: IssueWithContext['status']) => {
    setAnalysis(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        issues: prev.issues.map(issue =>
          issue.id === issueId ? { ...issue, status } : issue
        ),
      };
    });
  }, []);

  return (
    <AnalysisContext.Provider
      value={{
        analysis,
        loading,
        error,
        loadFromFile,
        loadFromUrl,
        selectedIssue,
        selectIssue,
        highlightedLocation,
        highlightLocation,
        navigateToLocation,
        updateIssueStatus,
        activeTab,
        setActiveTab,
      }}
    >
      {children}
    </AnalysisContext.Provider>
  );
}

export function useAnalysis() {
  const context = useContext(AnalysisContext);
  if (!context) {
    throw new Error('useAnalysis must be used within an AnalysisProvider');
  }
  return context;
}
