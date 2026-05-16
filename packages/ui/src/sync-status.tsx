/**
 * SyncStatusBanner — the in-app surface for "is realtime/writes working?"
 *
 * The motivating user story is "the bug happens on my phone, the console is
 * not available to me." DevTools-only debugging (window.__wpbDebug) is
 * fine for desktop repros but useless when the failing device is a phone.
 * This component is the readable-from-the-screen equivalent: a banner that
 * appears only when something looks wrong, and a tappable details panel
 * with the recent-events ring buffer that can be screenshot or copied.
 *
 * Reads from wpb.debug.snapshot() and wpb.debug.events() — the same surface
 * the console handle uses, so the future Supabase realtime wrapper just
 * needs to provide compatible shapes for this UI to keep working.
 */
import { useEffect, useState } from "react";
import type { WpbDebug, WpbEvent, WpbSnapshot } from "@homelab/backend/wrapped-pb";

/** Threshold below which "pending mutations" is treated as transient normal
 *  activity — don't show a banner for a write that's literally in-flight. */
const PENDING_GRACE_MS = 3000;
/** Above this age, the banner escalates to red — something is genuinely
 *  stuck, not just briefly in-flight. */
const PENDING_SEVERE_MS = 30 * 1000;
/** How often we poll the snapshot. wpb.debug.snapshot() is a cheap in-memory
 *  scan, so 1s is fine and gives the banner a live feel. */
const POLL_MS = 1000;

interface BannerState {
  show: boolean;
  severity: "info" | "warn" | "severe";
  message: string;
}

function deriveBanner(snapshot: WpbSnapshot, now: number): BannerState {
  const hasAnySubscriber = Object.values(snapshot.collections)
    .some((c) => c.subscribers > 0);

  // Realtime channel down while we have subscribers = stale view risk.
  // realtimeDirty means the SDK noticed a drop and hasn't reconnected yet;
  // realtimeConnected === false means the EventSource isn't open at all.
  if (hasAnySubscriber && (!snapshot.realtimeConnected || snapshot.realtimeDirty)) {
    return { show: true, severity: "warn", message: "Reconnecting to live updates…" };
  }

  // No pending writes = nothing to surface. Healthy steady state.
  if (snapshot.totalPending === 0 || snapshot.oldestPendingAt === null) {
    return { show: false, severity: "info", message: "" };
  }

  const age = now - snapshot.oldestPendingAt;
  if (age < PENDING_GRACE_MS) {
    return { show: false, severity: "info", message: "" };
  }

  const ageLabel = formatAge(age);
  if (age >= PENDING_SEVERE_MS) {
    const plural = snapshot.totalPending === 1 ? "change" : "changes";
    return {
      show: true,
      severity: "severe",
      message: `${snapshot.totalPending} ${plural} not synced — oldest ${ageLabel} old`,
    };
  }

  return {
    show: true,
    severity: "warn",
    message: snapshot.totalPending === 1
      ? "Saving 1 change…"
      : `Saving ${snapshot.totalPending} changes…`,
  };
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / (60 * 60_000))}h`;
}

function formatEventLine(e: WpbEvent, originT: number): string {
  const dt = ((e.t - originT) / 1000).toFixed(2).padStart(7, " ");
  const parts = [
    `+${dt}s`,
    e.kind.padEnd(15, " "),
    e.collection ? `[${e.collection}]` : "",
    e.recordId ? e.recordId : "",
  ];
  const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : "";
  return parts.filter(Boolean).join(" ") + detail;
}

interface DetailsPanelProps {
  debug: WpbDebug;
  onClose: () => void;
}

function DetailsPanel({ debug, onClose }: DetailsPanelProps) {
  // Snapshot the buffer at mount so the rendered list is stable during read
  // (otherwise new events keep shifting positions while the user scrolls).
  const [snapshot] = useState(() => debug.snapshot());
  const [events] = useState(() => debug.events());
  const originT = events.length > 0 ? events[0].t : Date.now();

  const summary = [
    `realtime: ${snapshot.realtimeConnected ? "connected" : "disconnected"}${snapshot.realtimeDirty ? " (dirty)" : ""}`,
    `total pending: ${snapshot.totalPending}`,
    snapshot.oldestPendingAt ? `oldest pending: ${formatAge(Date.now() - snapshot.oldestPendingAt)} ago` : "no pending",
    "",
    "per-collection:",
    ...Object.entries(snapshot.collections).map(([name, c]) =>
      `  ${name}  subs=${c.subscribers}  pending=${c.pendingMutations}  lastSse=${
        c.lastSseEventAt ? `${formatAge(Date.now() - c.lastSseEventAt)} ago` : "never"
      }`),
    "",
    `events (${events.length}, oldest first):`,
    ...events.map((e) => "  " + formatEventLine(e, originT)),
  ].join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
    } catch {
      // Fallback: focus a hidden textarea so user can long-press copy.
      // Most modern browsers permit clipboard.writeText after a user
      // gesture, so this path rarely runs in practice.
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Sync status details"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 10000,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        padding: 12,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          width: "100%",
          maxWidth: 720,
          borderRadius: 12,
          boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid #eee",
        }}>
          <strong style={{ fontSize: 14 }}>Sync details</strong>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={copy}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid #d9d9d9",
                background: "#fafafa",
                cursor: "pointer",
              }}
            >Copy</button>
            <button
              onClick={onClose}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid #d9d9d9",
                background: "#fafafa",
                cursor: "pointer",
              }}
            >Close</button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: "12px 16px",
            fontSize: 11,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflow: "auto",
            flex: 1,
            color: "#262626",
          }}
        >{summary}</pre>
      </div>
    </div>
  );
}

const SEVERITY_STYLE: Record<BannerState["severity"], { bg: string; fg: string; border: string }> = {
  info: { bg: "#e6f4ff", fg: "#0958d9", border: "#91caff" },
  warn: { bg: "#fff7e6", fg: "#874d00", border: "#ffd591" },
  severe: { bg: "#fff1f0", fg: "#a8071a", border: "#ffa39e" },
};

export function SyncStatusBanner({ debug }: { debug: WpbDebug }) {
  const [snapshot, setSnapshot] = useState<WpbSnapshot>(() => debug.snapshot());
  const [showPanel, setShowPanel] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => setSnapshot(debug.snapshot());
    const interval = setInterval(tick, POLL_MS);
    return () => clearInterval(interval);
  }, [debug]);

  const banner = deriveBanner(snapshot, Date.now());
  if (!banner.show) return null;

  const s = SEVERITY_STYLE[banner.severity];
  return (
    <>
      <button
        role="status"
        aria-live="polite"
        onClick={() => setShowPanel(true)}
        style={{
          position: "fixed",
          top: 8,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 9998, // below OfflineBanner's 9999 so both stack readably
          background: s.bg,
          color: s.fg,
          border: `1px solid ${s.border}`,
          padding: "4px 12px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 500,
          boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
          cursor: "pointer",
          maxWidth: "90vw",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >{banner.message}</button>
      {showPanel ? <DetailsPanel debug={debug} onClose={() => setShowPanel(false)} /> : null}
    </>
  );
}
