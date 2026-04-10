import { useEffect, useState } from 'react'

export function Settings() {
  const [extVersion, setExtVersion] = useState<string | null>(null)

  useEffect(() => {
    fetch('/extension/version').then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.available) setExtVersion(d.version) }).catch(() => {})
  }, [])

  return (
    <>
      <h2 style={{ marginBottom: 16 }}>Chrome Extension</h2>
      <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 12 }}>
        Captures financial data from bank websites and sends it to this server.
      </p>
      {extVersion ? (
        <>
          <a href="/extension/download" style={{
            display: 'inline-block', padding: '5px 14px', borderRadius: 4, border: 'none',
            background: '#818cf8', color: '#fff', fontSize: 12, textDecoration: 'none',
          }}>
            Download v{extVersion}
          </a>
          <details style={{ marginTop: 12, fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>
            <summary style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.6)' }}>Installation</summary>
            <ol style={{ paddingLeft: 20, marginTop: 8, lineHeight: 2 }}>
              <li>Download the .zip above and extract to a permanent folder</li>
              <li>Open <code>chrome://extensions</code> and enable Developer mode</li>
              <li>Click Load unpacked and select the extracted folder</li>
              <li>Navigate to a bank website — capture is automatic</li>
            </ol>
            <p style={{ marginTop: 4 }}>
              To update: download again, extract over the same folder, click reload on the extension card.
            </p>
          </details>
        </>
      ) : (
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>Extension not available on this server.</p>
      )}
    </>
  )
}
