import { useCallback } from 'react';
import { useAnalysis } from '../context/AnalysisContext';
import './FileLoader.css';

export function FileLoader() {
  const { loadFromFile, loading, error } = useAnalysis();

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) {
      loadFromFile(file);
    }
  }, [loadFromFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      loadFromFile(file);
    }
  }, [loadFromFile]);

  return (
    <div
      className="file-loader"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="file-loader-content">
        <div className="file-loader-icon">📄</div>
        <h2>Load Analysis</h2>
        <p>Drag and drop an analysis JSON file here, or click to browse</p>
        <input
          type="file"
          accept=".json"
          onChange={handleFileSelect}
          className="file-input"
        />
        <button className="browse-button" onClick={() => {
          document.querySelector<HTMLInputElement>('.file-input')?.click();
        }}>
          Browse Files
        </button>
        {loading && <p className="loading">Loading...</p>}
        {error && <p className="error">{error}</p>}
        <div className="hint">
          <p>Generate analysis with:</p>
          <code>book-editor analyze-v2 manuscript.md -o analysis.json</code>
        </div>
      </div>
    </div>
  );
}
