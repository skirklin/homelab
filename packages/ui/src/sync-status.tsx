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
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { WpbDebug, WpbEvent, WpbSnapshot, WpbCollectionSnapshot } from "@homelab/backend/wrapped-pb";
import { useOnline } from "./online-status";

/** Threshold below which "pending mutations" is treated as transient normal
 *  activity — don't show a banner for a write that's literally in-flight. */
const PENDING_GRACE_MS = 3000;
/** Above this age, the banner escalates to red — something is genuinely
 *  stuck, not just briefly in-flight. */
const PENDING_SEVERE_MS = 30 * 1000;
/** How often we poll the snapshot. wpb.debug.snapshot() is a cheap in-memory
 *  scan, so 1s is fine and gives the banner a live feel. */
const POLL_MS = 1000;

type Severity = "ok" | "info" | "warn" | "severe";

interface SyncState {
  /** Aggregate severity. "ok" means everything looks fine. */
  severity: Severity;
  /** Short user-facing label. Always non-empty so dot tooltips have text. */
  label: string;
  /** Number of pending mutations within the scoped collections. */
  pending: number;
  /** Subset that have already failed at least once and are awaiting retry. */
  errored: number;
  /** Age of oldest pending or errored mutation in ms, null if none. */
  oldestAgeMs: number | null;
}

/**
 * Compute aggregate sync state across an arbitrary set of collections.
 * When `collections` is undefined, scope is global (used by the banner).
 * When provided, only those collections are considered (used by per-app
 * header dots — keeps the shopping dot from turning yellow because a
 * pending write exists in upkeep).
 *
 * Severity ladder (highest match wins):
 *  - severe: any errored writes (already failed once, will retry on
 *    next PB_CONNECT/focus), or in-flight writes older than the severe
 *    threshold
 *  - warn:   in-flight writes older than the grace window
 *  - ok:     no pending, or all pending are still inside the grace
 *    window (normal in-flight latency)
 */
function deriveSyncState(
  snapshot: WpbSnapshot,
  now: number,
  collections?: readonly string[],
): SyncState {
  const scope = collections
    ? collections
      .map((name) => snapshot.collections[name])
      .filter((c): c is WpbCollectionSnapshot => !!c)
    : Object.values(snapshot.collections);

  const pending = scope.reduce((sum, c) => sum + c.pendingMutations, 0);
  const errored = scope.reduce((sum, c) => sum + c.erroredMutations, 0);
  const oldestPendingAt = scope
    .map((c) => c.oldestPendingAt)
    .filter((t): t is number => t !== null)
    .reduce<number | null>((acc, t) => (acc === null || t < acc ? t : acc), null);
  const oldestErroredAt = scope
    .map((c) => c.oldestErroredAt)
    .filter((t): t is number => t !== null)
    .reduce<number | null>((acc, t) => (acc === null || t < acc ? t : acc), null);

  // Errored writes mean the optimistic UI is showing changes the server
  // hasn't agreed to. Surface immediately — no grace window — because
  // they've already failed at least once.
  if (errored > 0) {
    const ageStr = oldestErroredAt !== null ? formatAge(now - oldestErroredAt) : "";
    const plural = errored === 1 ? "change" : "changes";
    return {
      severity: "severe",
      label: ageStr
        ? `${errored} ${plural} stuck retrying — ${ageStr} old`
        : `${errored} ${plural} stuck retrying`,
      pending,
      errored,
      oldestAgeMs: oldestErroredAt !== null ? now - oldestErroredAt : null,
    };
  }

  if (pending === 0 || oldestPendingAt === null) {
    return { severity: "ok", label: "Synced", pending: 0, errored: 0, oldestAgeMs: null };
  }

  const age = now - oldestPendingAt;
  if (age < PENDING_GRACE_MS) {
    return { severity: "ok", label: "Synced", pending, errored: 0, oldestAgeMs: age };
  }

  if (age >= PENDING_SEVERE_MS) {
    const plural = pending === 1 ? "change" : "changes";
    return {
      severity: "severe",
      label: `${pending} ${plural} not synced — oldest ${formatAge(age)} old`,
      pending,
      errored: 0,
      oldestAgeMs: age,
    };
  }

  return {
    severity: "warn",
    label: pending === 1 ? "Saving 1 change…" : `Saving ${pending} changes…`,
    pending,
    errored: 0,
    oldestAgeMs: age,
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
    `total pending: ${snapshot.totalPending} (errored: ${snapshot.totalErrored})`,
    snapshot.oldestPendingAt ? `oldest pending: ${formatAge(Date.now() - snapshot.oldestPendingAt)} ago` : "no pending",
    snapshot.oldestErroredAt ? `oldest errored: ${formatAge(Date.now() - snapshot.oldestErroredAt)} ago` : "no errored",
    "",
    "per-collection:",
    ...Object.entries(snapshot.collections).map(([name, c]) =>
      `  ${name}  pending=${c.pendingMutations}  errored=${c.erroredMutations}`),
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

const SEVERITY_PILL: Record<Exclude<Severity, "ok">, { bg: string; fg: string; border: string }> = {
  info: { bg: "#e6f4ff", fg: "#0958d9", border: "#91caff" },
  warn: { bg: "#fff7e6", fg: "#874d00", border: "#ffd591" },
  severe: { bg: "#fff1f0", fg: "#a8071a", border: "#ffa39e" },
};

const SEVERITY_DOT: Record<Severity, string> = {
  ok: "#52c41a",     // green
  info: "#1677ff",   // blue
  warn: "#faad14",   // yellow
  severe: "#ff4d4f", // red
};

/**
 * Shared poll loop for snapshot consumers. Polling 1Hz is fine for an
 * in-memory read; we don't want a per-component setInterval explosion if
 * multiple consumers (banner + per-app dots) mount at once, but in practice
 * each render tree mounts ~one of each, so the cost is bounded.
 */
function useSnapshot(debug: WpbDebug): WpbSnapshot {
  const [snapshot, setSnapshot] = useState<WpbSnapshot>(() => debug.snapshot());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => setSnapshot(debug.snapshot());
    const interval = setInterval(tick, POLL_MS);
    return () => clearInterval(interval);
  }, [debug]);
  return snapshot;
}

/**
 * "Browser back closes the modal" pattern, raw — we can't use react-router
 * URL params because the SyncDot/banner are rendered as a global overlay
 * outside any router-controlled tree, and consumers vary (some apps wrap
 * the dot in a Router, some don't).
 *
 * On open: push a sentinel history entry so the back gesture has something
 * to pop. On popstate: close the panel (the entry is already gone — the
 * browser ate it). On explicit close: call history.back() so the sentinel
 * we pushed gets popped naturally, keeping the history stack clean.
 *
 * Reentrancy guard: the close-triggered history.back() fires popstate too;
 * `closingRef` prevents it from re-running setOpen(false) and (more
 * importantly) prevents the cleanup branch from going back twice on unmount.
 *
 * Per-instance ownership: the sentinel value is a unique id (via useId) so
 * banner-and-dot-both-open works correctly — each hook only reacts to its
 * own popstate and only cleans up its own sentinel.
 *
 * Restore hygiene: iOS Safari restores `history.state` across reloads. If
 * a stale `{ kirklSyncPanel: ... }` survives a refresh while `open=false`,
 * we clear it on mount to avoid mis-detecting ownership on next open.
 *
 * Router-popstate guard: cleanup only calls `history.back()` when the
 * sentinel actually belongs to this instance AND the panel was still
 * considered open by this hook. Protects against route-level unmounts
 * sending the user one extra step back.
 */
function useHistoryDismiss(open: boolean, setOpen: (v: boolean) => void): void {
  const instanceId = useId();
  const wasOpenRef = useRef(false);

  // Clear a leaked sentinel from a previous page-load (iOS history.state
  // restore) so the first open of this session sees a clean slate. Only
  // clear if `kirklSyncPanel` is the only key — don't trample any other
  // library that may also stash state on history.state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const st = window.history.state;
    if (!open && st && typeof st === "object" && "kirklSyncPanel" in st) {
      const keys = Object.keys(st);
      if (keys.length === 1 && keys[0] === "kirklSyncPanel") {
        window.history.replaceState(null, "");
      }
    }
    // Run once on mount — subsequent reentries are managed by the open effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (typeof window === "undefined") return;

    wasOpenRef.current = true;
    let closing = false;

    window.history.pushState({ kirklSyncPanel: instanceId }, "");

    const onPopState = () => {
      // Only react if this pop is for *our* sentinel. After our entry has
      // been popped, the new top of stack will have a different (or no)
      // kirklSyncPanel value — that's the signal it was ours.
      const top = window.history.state;
      const stillOurs = top && typeof top === "object" && top.kirklSyncPanel === instanceId;
      if (stillOurs) {
        // A different panel's sentinel above ours got popped — ignore.
        return;
      }
      closing = true;
      setOpen(false);
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
      // Only pop our sentinel if:
      //  - we're not unmounting because back was just pressed (closing flag), and
      //  - this hook still thinks the panel is open (guards against parent
      //    re-renders / route-level unmounts), and
      //  - our sentinel is still on top of the history stack.
      const top = window.history.state;
      const stillOurs = top && typeof top === "object" && top.kirklSyncPanel === instanceId;
      if (!closing && wasOpenRef.current && stillOurs) {
        window.history.back();
      }
    };
  }, [open, setOpen, instanceId]);
}

/** Trigger panel close by popping our sentinel — popstate handler will
 *  then call setOpen(false). Used as the panel's onClose. */
const closePanel = () => window.history.back();

export function SyncStatusBanner({ debug }: { debug: WpbDebug }) {
  const snapshot = useSnapshot(debug);
  const [showPanel, setShowPanel] = useState(false);
  const online = useOnline();
  useHistoryDismiss(showPanel, setShowPanel);

  const state = deriveSyncState(snapshot, Date.now());
  // Banner is only the loud surface — silent when everything looks fine.
  // The persistent per-app dots cover the ambient at-a-glance need.
  if (state.severity === "ok") {
    return showPanel
      ? <DetailsPanel debug={debug} onClose={closePanel} />
      : null;
  }

  const s = SEVERITY_PILL[state.severity];
  return (
    <>
      <button
        role="status"
        aria-live="polite"
        onClick={() => setShowPanel(true)}
        style={{
          position: "fixed",
          // When offline, the OfflineBanner sits at top:8 with pointerEvents:
          // none on top of us (zIndex 9999 vs 9998). It visually occludes us
          // AND blocks taps. Stack below it so both pills are visible and
          // tappable.
          // Use safe-area inset so the pill clears the iOS notch / Dynamic
          // Island even though `position: fixed` is anchored to the viewport
          // rather than the body's safe-area padding.
          top: online
            ? "calc(8px + env(safe-area-inset-top))"
            : "calc(44px + env(safe-area-inset-top))",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 9998,
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
      >{state.label}</button>
      {showPanel ? <DetailsPanel debug={debug} onClose={closePanel} /> : null}
    </>
  );
}

/**
 * Compact always-visible per-app health dot.
 *
 * Replaces the shopping-only SyncIndicator that was hard-wired to "always
 * green after first load." Reads live state from wpb scoped to the
 * collections this app actually subscribes to, so a stuck write in upkeep
 * doesn't yellow the shopping dot.
 *
 * Tap/click opens the same details panel the banner does — gives a way
 * into the debug info from any app's header even when nothing is wrong
 * yet, which matters when the problem is on a phone where the console
 * isn't available.
 */
export interface SyncDotProps {
  debug: WpbDebug;
  /** Collection names this app subscribes to. Used to scope the indicator
   *  so each app's dot reflects only its own data. */
  collections: readonly string[];
}

export function SyncDot({ debug, collections }: SyncDotProps) {
  const snapshot = useSnapshot(debug);
  const [showPanel, setShowPanel] = useState(false);
  const cols = useMemo(() => [...collections], [collections]);
  const state = deriveSyncState(snapshot, Date.now(), cols);
  useHistoryDismiss(showPanel, setShowPanel);

  return (
    <>
      <button
        aria-label={`Sync status: ${state.label}`}
        title={state.label}
        onClick={() => setShowPanel(true)}
        style={{
          // 40×40 hit area for phone taps — visible dot stays 14×14 via
          // the inner span. Audit found 14×14 was below the iOS/Android
          // tap-target threshold.
          width: 40,
          height: 40,
          padding: 0,
          borderRadius: "50%",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: SEVERITY_DOT[state.severity],
            display: "block",
            // Subtle pulse on non-ok states so motion draws the eye without
            // being obnoxious.
            animation: state.severity === "ok" ? undefined : "kirkl-sync-pulse 1.5s ease-in-out infinite",
          }}
        />
      </button>
      {/* Single keyframe definition. styled-components is used elsewhere but
          we keep this component dep-free so it can be dropped into any app
          header without extra imports. */}
      <style>{`@keyframes kirkl-sync-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
      {showPanel ? <DetailsPanel debug={debug} onClose={closePanel} /> : null}
    </>
  );
}
