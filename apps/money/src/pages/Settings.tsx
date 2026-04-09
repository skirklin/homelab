import { useEffect, useState } from 'react'

interface PersonEntry { name: string }
interface InstitutionEntry { label: string; [key: string]: string }
interface LoginEntry { person: string; institution: string; [key: string]: string }

interface Config {
  people: Record<string, PersonEntry>
  institutions: Record<string, InstitutionEntry>
  logins: Record<string, LoginEntry>
}

const EMPTY: Config = { people: {}, institutions: {}, logins: {} }

const cellInput: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'inherit',
  fontSize: 'inherit', fontFamily: 'inherit', width: '100%', padding: 0,
  outline: 'none',
}

export function Settings() {
  const [config, setConfig] = useState<Config>(EMPTY)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [extVersion, setExtVersion] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(d => {
      const c = d.config || {}
      setConfig({ people: c.people || {}, institutions: c.institutions || {}, logins: c.logins || {} })
    }).catch(() => {})
    fetch('/extension/version').then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.available) setExtVersion(d.version) }).catch(() => {})
  }, [])

  function update(fn: (c: Config) => Config) {
    setConfig(c => fn(c))
    setDirty(true)
    setMsg(null)
  }

  async function save() {
    setSaving(true)
    try {
      const r = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      })
      const d = await r.json()
      setMsg(r.ok ? { text: 'Saved', ok: true } : { text: d.error, ok: false })
      if (r.ok) setDirty(false)
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }) }
    finally { setSaving(false) }
  }

  const people = Object.entries(config.people)
  const institutions = Object.entries(config.institutions)
  const logins = Object.entries(config.logins)

  return (
    <>
      {/* Save bar — only shows when dirty */}
      {dirty && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <button
            onClick={save} disabled={saving}
            style={{
              padding: '5px 16px', borderRadius: 4, border: 'none',
              background: '#818cf8', color: '#fff', fontSize: 12,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
          {msg && <span style={{ fontSize: 12, color: msg.ok ? '#4ade80' : '#f87171' }}>{msg.text}</span>}
        </div>
      )}

      {/* Extension — minimal */}
      {extVersion && (
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <a
            href="/extension/download"
            style={{
              padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)',
              color: 'rgba(255,255,255,0.7)', textDecoration: 'none', fontSize: 12,
            }}
          >
            Extension v{extVersion}
          </a>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
            Download, unzip, load unpacked in chrome://extensions
          </span>
        </div>
      )}

      {/* People */}
      <table className="accounts-table" style={{ marginBottom: 24 }}>
        <thead>
          <tr>
            <th>Person</th>
            <th>Name</th>
            <th style={{ width: 30 }}>
              <button
                onClick={() => {
                  const id = prompt('ID (e.g. "scott"):')
                  if (id) update(c => ({ ...c, people: { ...c.people, [id]: { name: '' } } }))
                }}
                style={{ background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer', fontSize: 11 }}
              >+</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {people.map(([id, p]) => (
            <tr key={id}>
              <td><code className="dim">{id}</code></td>
              <td>
                <input
                  style={cellInput} value={p.name}
                  onChange={e => update(c => ({ ...c, people: { ...c.people, [id]: { name: e.target.value } } }))}
                />
              </td>
              <td>
                <button
                  onClick={() => update(c => { const { [id]: _, ...rest } = c.people; return { ...c, people: rest } })}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 11 }}
                >✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Institutions */}
      <table className="accounts-table" style={{ marginBottom: 24 }}>
        <thead>
          <tr>
            <th>Institution</th>
            <th>Label</th>
            <th style={{ width: 30 }}>
              <button
                onClick={() => {
                  const id = prompt('ID (e.g. "chase"):')
                  if (id) update(c => ({ ...c, institutions: { ...c.institutions, [id]: { ...c.institutions[id], label: '' } } }))
                }}
                style={{ background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer', fontSize: 11 }}
              >+</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {institutions.map(([id, inst]) => (
            <tr key={id}>
              <td><code className="dim">{id}</code></td>
              <td>
                <input style={cellInput} value={inst.label}
                  onChange={e => update(c => ({ ...c, institutions: { ...c.institutions, [id]: { ...c.institutions[id], label: e.target.value } } }))} />
              </td>
              <td>
                <button
                  onClick={() => update(c => { const { [id]: _, ...rest } = c.institutions; return { ...c, institutions: rest } })}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 11 }}
                >✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Logins */}
      <table className="accounts-table">
        <thead>
          <tr>
            <th>Login</th>
            <th style={{ width: 30 }}>
              <button
                onClick={() => {
                  const pIds = Object.keys(config.people)
                  const iIds = Object.keys(config.institutions)
                  if (!pIds.length || !iIds.length) { alert('Add people and institutions first.'); return }
                  const person = prompt(`Person (${pIds.join(', ')}):`)
                  if (!person || !config.people[person]) return
                  const inst = prompt(`Institution (${iIds.join(', ')}):`)
                  if (!inst || !config.institutions[inst]) return
                  update(c => ({ ...c, logins: { ...c.logins, [`${person}@${inst}`]: { person, institution: inst, op_item: '', vault: '' } } }))
                }}
                style={{ background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer', fontSize: 11 }}
              >+</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {logins.map(([id]) => (
            <tr key={id}>
              <td><code className="dim">{id}</code></td>
              <td>
                <button
                  onClick={() => update(c => { const { [id]: _, ...rest } = c.logins; return { ...c, logins: rest } })}
                  style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 11 }}
                >✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
