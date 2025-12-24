import { useEffect } from 'react'
import { AnalysisProvider, useAnalysis } from './context/AnalysisContext'
import { Layout } from './components/Layout'
import { FileLoader } from './components/FileLoader'
import { IssuesView } from './components/IssuesView'
import { ManuscriptView } from './components/ManuscriptView'
import { CharactersView } from './components/CharactersView'
import { TimelineView } from './components/TimelineView'
import { PlotThreadsView } from './components/PlotThreadsView'
import './App.css'

function AppContent() {
  const { analysis, loadFromUrl, loading } = useAnalysis()

  // Check for file query param on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const fileUrl = params.get('file')
    if (fileUrl && !analysis && !loading) {
      loadFromUrl(fileUrl)
    }
  }, [analysis, loading, loadFromUrl])

  if (!analysis) {
    return <FileLoader />
  }

  return (
    <Layout>
      {{
        issues: <IssuesView />,
        manuscript: <ManuscriptView />,
        characters: <CharactersView />,
        timeline: <TimelineView />,
        threads: <PlotThreadsView />,
      }}
    </Layout>
  )
}

function App() {
  return (
    <AnalysisProvider>
      <AppContent />
    </AnalysisProvider>
  )
}

export default App
