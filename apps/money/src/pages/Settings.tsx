import { useEffect, useState } from 'react'

interface ExtensionVersion {
  version: string
  download_url: string
  available: boolean
}

interface PersonEntry { name: string }
interface InstitutionEntry { label: string; auth: string; url: string }
interface LoginEntry { person: string; institution: string; op_item: string; vault: string }

interface Config {
  people: Record<string, PersonEntry>
  institutions: Record<string, InstitutionEntry>
  logins: Record<string, LoginEntry>
}

const EMPTY_CONFIG: Config = { people: {}, institutions: {}, logins: {} }

const inputStyle: React.CSSProperties = {
  padding: '6px 8px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13, width: '100%',
}
const btnStyle: React.CSSProperties = {
  padding: '6px 14px', background: '#1a1a2e', color: 'white', border: 'none',
  borderRadius: 4, cursor: 'pointer', fontSize: 13,
}
const dangerBtnStyle: React.CSSProperties = {
  ...btnStyle, background: 'transparent', color: '#dc2626', padding: '6px 8px',
}
const cardStyle: React.CSSProperties = {
  border: '1px solid #e5e5e5', borderRadius: 8, padding: 16, marginBottom: 12, background: 'white',
}
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#666', marginBottom: 2, display: 'block' }

export function Settings() {
  const [config, setConfig] = useState<Config>(EMPTY_CONFIG)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [extensionInfo, setExtensionInfo] = useState<ExtensionVersion | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showJson, setShowJson] = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        const raw = data.config || {}
        setConfig({
          people: raw.people || {},
          institutions: raw.institutions || {},
          logins: raw.logins || {},
        })
        if (!data.exists) setMessage({ text: 'No config found — add your setup below.', ok: true })
      })
      .catch(e => setError(e.message))

    fetch('/extension/version')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setExtensionInfo(data) })
      .catch(() => {})

    // Detect the server URL for the install command
    setServerUrl(window.location.origin)
  }, [])

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    try {
      const resp = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      })
      const data = await resp.json()
      if (resp.ok) setMessage({ text: 'Saved. Changes take effect immediately.', ok: true })
      else setMessage({ text: `Error: ${data.error}`, ok: false })
    } catch (e) {
      setMessage({ text: `Error: ${(e as Error).message}`, ok: false })
    } finally {
      setSaving(false)
    }
  }

  // ── People ──

  function addPerson() {
    const id = prompt('Person ID (lowercase, e.g. "scott"):')
    if (!id) return
    const name = prompt('Display name:')
    if (!name) return
    setConfig(c => ({ ...c, people: { ...c.people, [id]: { name } } }))
  }

  function removePerson(id: string) {
    setConfig(c => {
      const { [id]: _, ...rest } = c.people
      return { ...c, people: rest }
    })
  }

  // ── Institutions ──

  function addInstitution() {
    const id = prompt('Institution ID (lowercase, e.g. "chase"):')
    if (!id) return
    const label = prompt('Display name (e.g. "Chase"):') || id
    setConfig(c => ({
      ...c,
      institutions: { ...c.institutions, [id]: { label, auth: 'cookies', url: '' } },
    }))
  }

  function updateInstitution(id: string, field: keyof InstitutionEntry, value: string) {
    setConfig(c => ({
      ...c,
      institutions: { ...c.institutions, [id]: { ...c.institutions[id], [field]: value } },
    }))
  }

  function removeInstitution(id: string) {
    setConfig(c => {
      const { [id]: _, ...rest } = c.institutions
      return { ...c, institutions: rest }
    })
  }

  // ── Logins ──

  function addLogin() {
    const personIds = Object.keys(config.people)
    const instIds = Object.keys(config.institutions)
    if (personIds.length === 0 || instIds.length === 0) {
      alert('Add at least one person and one institution first.')
      return
    }
    const person = prompt(`Person (${personIds.join(', ')}):`)
    if (!person || !config.people[person]) { alert('Unknown person'); return }
    const institution = prompt(`Institution (${instIds.join(', ')}):`)
    if (!institution || !config.institutions[institution]) { alert('Unknown institution'); return }
    const loginId = `${person}@${institution}`
    setConfig(c => ({
      ...c,
      logins: { ...c.logins, [loginId]: { person, institution, op_item: '', vault: '' } },
    }))
  }

  function updateLogin(id: string, field: keyof LoginEntry, value: string) {
    setConfig(c => ({
      ...c,
      logins: { ...c.logins, [id]: { ...c.logins[id], [field]: value } },
    }))
  }

  function removeLogin(id: string) {
    setConfig(c => {
      const { [id]: _, ...rest } = c.logins
      return { ...c, logins: rest }
    })
  }

  if (error) return <div style={{ padding: 24, color: '#dc2626' }}>Error: {error}</div>

  const installCmd = `curl -sL ${serverUrl}/extension/install.sh | sh`

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
      <h2 style={{ marginBottom: 24 }}>Settings</h2>

      {/* ── Extension ── */}
      <section style={{ marginBottom: 32 }}>
        <h3 style={{ marginBottom: 12 }}>Chrome Extension</h3>
        <p style={{ color: '#666', fontSize: 14, marginBottom: 12 }}>
          The Money Collector extension captures financial data from your bank websites
          and sends it to this server.
        </p>

        {extensionInfo?.available ? (
          <div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <a href="/extension/download" style={{ ...btnStyle, textDecoration: 'none', display: 'inline-block' }}>
                Download v{extensionInfo.version} (.zip)
              </a>
              <span style={{ color: '#666', fontSize: 13 }}>or install via terminal:</span>
            </div>
            <code
              style={{
                display: 'block', padding: '10px 12px', background: '#f1f5f9',
                borderRadius: 6, fontSize: 13, fontFamily: 'monospace', userSelect: 'all',
                border: '1px solid #e2e8f0',
              }}
            >
              {installCmd}
            </code>
            <p style={{ color: '#888', fontSize: 12, marginTop: 6 }}>
              Installs to <code>~/money-collector-extension</code>. Re-run to update.
              After first install, open <code>chrome://extensions</code>, enable Developer mode,
              click "Load unpacked", and select that folder.
            </p>
          </div>
        ) : (
          <p style={{ color: '#999', fontSize: 13 }}>
            Extension not available on this server yet.
          </p>
        )}
      </section>

      {/* ── People ── */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3>People</h3>
          <button style={btnStyle} onClick={addPerson}>+ Add Person</button>
        </div>
        {Object.entries(config.people).length === 0 && (
          <p style={{ color: '#999', fontSize: 13 }}>No people configured. Add yourself and anyone else who will use the extension.</p>
        )}
        {Object.entries(config.people).map(([id, person]) => (
          <div key={id} style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12 }}>
            <code style={{ fontSize: 13, minWidth: 80, color: '#4a5568' }}>{id}</code>
            <input
              style={inputStyle}
              value={person.name}
              onChange={e => setConfig(c => ({
                ...c, people: { ...c.people, [id]: { name: e.target.value } },
              }))}
              placeholder="Display name"
            />
            <button style={dangerBtnStyle} onClick={() => removePerson(id)} title="Remove">✕</button>
          </div>
        ))}
      </section>

      {/* ── Institutions ── */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3>Institutions</h3>
          <button style={btnStyle} onClick={addInstitution}>+ Add Institution</button>
        </div>
        {Object.entries(config.institutions).length === 0 && (
          <p style={{ color: '#999', fontSize: 13 }}>No institutions configured.</p>
        )}
        {Object.entries(config.institutions).map(([id, inst]) => (
          <div key={id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <code style={{ fontSize: 13, color: '#4a5568', fontWeight: 600 }}>{id}</code>
              <span style={{ flex: 1 }} />
              <button style={dangerBtnStyle} onClick={() => removeInstitution(id)} title="Remove">✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>Label</label>
                <input style={inputStyle} value={inst.label} onChange={e => updateInstitution(id, 'label', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Auth method</label>
                <select
                  style={{ ...inputStyle, background: 'white' }}
                  value={inst.auth}
                  onChange={e => updateInstitution(id, 'auth', e.target.value)}
                >
                  <option value="cookies">cookies</option>
                  <option value="network_log">network_log</option>
                  <option value="playwright">playwright</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>URL</label>
                <input style={inputStyle} value={inst.url} onChange={e => updateInstitution(id, 'url', e.target.value)} placeholder="https://..." />
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* ── Logins ── */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3>Logins</h3>
          <button style={btnStyle} onClick={addLogin}>+ Add Login</button>
        </div>
        <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
          Each login maps a person to an institution. The extension uses your selected profile
          to route captured data to the right login.
        </p>
        {Object.entries(config.logins).length === 0 && (
          <p style={{ color: '#999', fontSize: 13 }}>No logins configured. Add people and institutions first, then create logins.</p>
        )}
        {Object.entries(config.logins).map(([id, login]) => (
          <div key={id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <code style={{ fontSize: 13, color: '#4a5568', fontWeight: 600 }}>{id}</code>
              <span style={{ fontSize: 12, color: '#999' }}>
                {config.people[login.person]?.name || login.person} @ {config.institutions[login.institution]?.label || login.institution}
              </span>
              <span style={{ flex: 1 }} />
              <button style={dangerBtnStyle} onClick={() => removeLogin(id)} title="Remove">✕</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={labelStyle}>1Password item (optional)</label>
                <input style={inputStyle} value={login.op_item} onChange={e => updateLogin(id, 'op_item', e.target.value)} placeholder="e.g. Chase" />
              </div>
              <div>
                <label style={labelStyle}>1Password vault (optional)</label>
                <input style={inputStyle} value={login.vault} onChange={e => updateLogin(id, 'vault', e.target.value)} placeholder="e.g. Finances" />
              </div>
            </div>
          </div>
        ))}
      </section>

      {/* ── Save bar ── */}
      <div style={{
        position: 'sticky', bottom: 0, background: '#f8fafc', borderTop: '1px solid #e5e5e5',
        padding: '12px 0', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <button onClick={handleSave} disabled={saving} style={{ ...btnStyle, padding: '10px 24px', fontSize: 14 }}>
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
        {message && (
          <span style={{ fontSize: 13, color: message.ok ? '#16a34a' : '#dc2626' }}>{message.text}</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setShowJson(!showJson)}
          style={{ ...dangerBtnStyle, color: '#666' }}
        >
          {showJson ? 'Hide' : 'Show'} JSON
        </button>
      </div>

      {showJson && (
        <pre style={{
          marginTop: 12, padding: 12, background: '#f1f5f9', borderRadius: 6,
          fontSize: 12, fontFamily: 'monospace', overflow: 'auto', maxHeight: 400,
        }}>
          {JSON.stringify(config, null, 2)}
        </pre>
      )}
    </div>
  )
}
