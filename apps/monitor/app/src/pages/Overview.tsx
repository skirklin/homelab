import { useEffect, useState } from "react";
import {
  fetchDeployments,
  fetchGatusStatuses,
  fetchPodEvents,
  type Deployment,
  type GatusEndpoint,
  type PodEvent,
} from "../api";
import { fmtDuration, groupBy, shortSha, timeAgo } from "../utils";

export function Overview() {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [endpoints, setEndpoints] = useState<GatusEndpoint[] | null>(null);
  const [events, setEvents] = useState<PodEvent[] | null>(null);
  const [eventsAll, setEventsAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [d, g, e] = await Promise.all([
        fetchDeployments(20),
        fetchGatusStatuses(),
        fetchPodEvents(eventsAll ? { limit: 100 } : { type: "Warning", limit: 50 }),
      ]);
      setDeployments(d);
      setEndpoints(g);
      setEvents(e);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsAll]);

  return (
    <>
      {error && <div className="error">Error: {error}</div>}

      <section className="section">
        <div className="section-header">
          <h2>Uptime</h2>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {endpoints ? <UptimeView endpoints={endpoints} /> : <div className="loading">Loading…</div>}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Cluster events</h2>
          <button className="btn" onClick={() => setEventsAll((v) => !v)}>
            {eventsAll ? "Warnings only" : "Show all"}
          </button>
        </div>
        {events ? <EventsTable rows={events} /> : <div className="loading">Loading…</div>}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Recent deployments</h2>
        </div>
        {deployments ? <DeploymentsTable rows={deployments} /> : <div className="loading">Loading…</div>}
      </section>
    </>
  );
}

function UptimeView({ endpoints }: { endpoints: GatusEndpoint[] }) {
  if (endpoints.length === 0) return <div className="muted">No checks configured.</div>;
  const groups = groupBy(endpoints, (e) => e.group || "default");

  return (
    <>
      {Object.entries(groups).map(([group, items]) => (
        <div key={group} className="uptime-group">
          <h3>{group}</h3>
          <div className="uptime-cards">
            {items.map((e) => <UptimeCard key={e.key} endpoint={e} />)}
          </div>
        </div>
      ))}
    </>
  );
}

function UptimeCard({ endpoint }: { endpoint: GatusEndpoint }) {
  const latest = endpoint.results[endpoint.results.length - 1];
  const status = !latest ? "gray" : latest.success ? "green" : "red";
  const ms = latest ? Math.round(latest.duration / 1_000_000) : null;
  const recent = endpoint.results.slice(-20);
  const successRate = recent.length
    ? Math.round((recent.filter((r) => r.success).length / recent.length) * 100)
    : null;

  return (
    <div className="uptime-card">
      <div className={`dot ${status}`} />
      <div className="info">
        <div className="name">{endpoint.name}</div>
        <div className="meta">
          {ms !== null ? `${ms}ms` : "—"}
          {successRate !== null && ` · ${successRate}% (last ${recent.length})`}
          {latest && ` · ${timeAgo(latest.timestamp)}`}
        </div>
      </div>
    </div>
  );
}

function EventsTable({ rows }: { rows: PodEvent[] }) {
  if (rows.length === 0) {
    return <div className="muted">No events captured. The event-watcher should start streaming once deployed.</div>;
  }
  return (
    <table className="deployments">
      <thead>
        <tr>
          <th></th>
          <th>When</th>
          <th>Pod</th>
          <th>Reason</th>
          <th>Message</th>
          <th>Count</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><div className={`dot ${r.type === "Warning" ? "red" : "green"}`} /></td>
            <td className="muted" title={r.last_seen}>{timeAgo(r.last_seen)}</td>
            <td className="sha">{r.namespace}/{r.involved_name}</td>
            <td>{r.reason}</td>
            <td className="subject" title={r.message}>{r.message}</td>
            <td className="muted">{r.count > 1 ? `×${r.count}` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DeploymentsTable({ rows }: { rows: Deployment[] }) {
  if (rows.length === 0) {
    return <div className="muted">No deployments recorded yet. Run <code>./infra/deploy.sh</code> to create the first record.</div>;
  }
  return (
    <table className="deployments">
      <thead>
        <tr>
          <th></th>
          <th>When</th>
          <th>Commit</th>
          <th>Subject</th>
          <th>Apps</th>
          <th>Deployer</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td><div className={`dot ${r.status === "success" ? "green" : r.status === "partial" ? "amber" : "red"}`} /></td>
            <td className="muted">{timeAgo(r.created)}</td>
            <td className="sha">{shortSha(r.git_sha)}</td>
            <td className="subject" title={r.git_subject}>{r.git_subject || <span className="muted">—</span>}</td>
            <td className="apps">{Array.isArray(r.apps) ? r.apps.join(", ") : ""}</td>
            <td className="muted">{r.deployer || "—"}</td>
            <td className="muted">{fmtDuration(r.duration_seconds)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
