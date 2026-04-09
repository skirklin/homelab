import { useEffect, useState } from 'react'

interface ExtensionVersion {
  version: string
  download_url: string
  available: boolean
}

interface ConfigState {
  config: Record<string, unknown>
  path: string
  exists: boolean
}

export function Settings() {
  const [configText, setConfigText] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [extensionInfo, setExtensionInfo] = useState<ExtensionVersion | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then((data: ConfigState) => {
        setConfigText(JSON.stringify(data.config, null, 2))
        setConfigPath(data.path)
        if (!data.exists) setSaveMessage('No config file found. Add your config below and save.')
      })
      .catch(e => setError(e.message))

    fetch('/extension/version')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setExtensionInfo(data) })
      .catch(() => {})
  }, [])

  async function handleSave() {
    setSaving(true)
    setSaveMessage(null)
    try {
      const parsed = JSON.parse(configText)
      const resp = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: parsed }),
      })
      const data = await resp.json()
      if (resp.ok) {
        setSaveMessage(`Saved to ${data.path}`)
        setConfigPath(data.path)
      } else {
        setSaveMessage(`Error: ${data.error}`)
      }
    } catch (e) {
      setSaveMessage(`Invalid JSON: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (error) return <div style={{ padding: 24, color: '#dc2626' }}>Error: {error}</div>

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
      <h2 style={{ marginBottom: 24 }}>Settings</h2>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ marginBottom: 12 }}>Chrome Extension</h3>
        <p style={{ color: '#666', fontSize: 14, marginBottom: 12 }}>
          The Money Collector extension captures financial data from your bank websites
          and sends it to this server for processing.
        </p>
        {extensionInfo?.available ? (
          <a
            href="/extension/download"
            style={{
              display: 'inline-block',
              padding: '8px 16px',
              background: '#1a1a2e',
              color: 'white',
              borderRadius: 6,
              textDecoration: 'none',
              fontSize: 14,
            }}
          >
            Download Extension v{extensionInfo.version}
          </a>
        ) : (
          <p style={{ color: '#999', fontSize: 13 }}>
            Extension not built yet. Run <code>infra/build-extension.sh</code> and copy the
            zip to the server.
          </p>
        )}
        <details style={{ marginTop: 12, fontSize: 13, color: '#666' }}>
          <summary style={{ cursor: 'pointer' }}>Installation instructions</summary>
          <ol style={{ paddingLeft: 20, marginTop: 8, lineHeight: 1.8 }}>
            <li>Download the zip file above</li>
            <li>Unzip it to a folder on your computer</li>
            <li>Open Chrome and go to <code>chrome://extensions</code></li>
            <li>Enable "Developer mode" (top right toggle)</li>
            <li>Click "Load unpacked" and select the unzipped folder</li>
            <li>Open the extension popup and select your profile (scott / angela)</li>
            <li>Navigate to a supported bank website — data capture is automatic</li>
          </ol>
        </details>
      </section>

      <section>
        <h3 style={{ marginBottom: 8 }}>Configuration</h3>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 8 }}>
          Loaded from: <code>{configPath}</code>
        </p>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
          Defines institutions, logins, and people. Changes take effect immediately (no
          restart needed).
        </p>
        <textarea
          value={configText}
          onChange={e => setConfigText(e.target.value)}
          spellCheck={false}
          style={{
            width: '100%',
            minHeight: 400,
            fontFamily: 'monospace',
            fontSize: 13,
            padding: 12,
            border: '1px solid #ddd',
            borderRadius: 6,
            resize: 'vertical',
            background: '#fafafa',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '8px 20px',
              background: saving ? '#ccc' : '#1a1a2e',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: 14,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {saveMessage && (
            <span style={{ fontSize: 13, color: saveMessage.startsWith('Error') || saveMessage.startsWith('Invalid') ? '#dc2626' : '#16a34a' }}>
              {saveMessage}
            </span>
          )}
        </div>
      </section>
    </div>
  )
}
