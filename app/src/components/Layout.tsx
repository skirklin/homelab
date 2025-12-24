import { useEffect, useCallback, type ReactNode } from 'react';
import { useAnalysis, type TabId } from '../context/AnalysisContext';
import './Layout.css';

interface Tab {
  id: TabId;
  label: string;
  badge?: number;
}

interface LayoutProps {
  children: Record<TabId, ReactNode>;
}

const TAB_ORDER: TabId[] = ['issues', 'manuscript', 'characters', 'timeline', 'threads'];

export function Layout({ children }: LayoutProps) {
  const { analysis, activeTab, setActiveTab } = useAnalysis();

  // Keyboard navigation for tabs
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Only handle if no input/textarea is focused
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
      return;
    }

    const currentIndex = TAB_ORDER.indexOf(activeTab);

    if (e.key === 'ArrowLeft' || (e.key === '[' && !e.metaKey)) {
      e.preventDefault();
      const newIndex = currentIndex > 0 ? currentIndex - 1 : TAB_ORDER.length - 1;
      setActiveTab(TAB_ORDER[newIndex]);
    } else if (e.key === 'ArrowRight' || (e.key === ']' && !e.metaKey)) {
      e.preventDefault();
      const newIndex = currentIndex < TAB_ORDER.length - 1 ? currentIndex + 1 : 0;
      setActiveTab(TAB_ORDER[newIndex]);
    } else if (e.key >= '1' && e.key <= '5') {
      // Number keys 1-5 for direct tab access
      e.preventDefault();
      const tabIndex = parseInt(e.key) - 1;
      if (tabIndex < TAB_ORDER.length) {
        setActiveTab(TAB_ORDER[tabIndex]);
      }
    }
  }, [activeTab]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const tabs: Tab[] = [
    {
      id: 'issues',
      label: 'Issues',
      badge: analysis?.summary.issueCount
    },
    {
      id: 'manuscript',
      label: 'Manuscript'
    },
    {
      id: 'characters',
      label: 'Characters',
      badge: analysis?.summary.characterCount
    },
    {
      id: 'timeline',
      label: 'Timeline',
      badge: analysis?.summary.eventCount
    },
    {
      id: 'threads',
      label: 'Plot Threads',
      badge: analysis?.summary.plotThreadCount
    },
  ];

  return (
    <div className="layout">
      <nav className="tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="badge">{tab.badge}</span>
            )}
          </button>
        ))}
      </nav>
      <main className="tab-content">
        {children[activeTab]}
      </main>
    </div>
  );
}
