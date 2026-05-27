import { Link, useLocation, useNavigate } from "react-router-dom";

export interface NotFoundShortcut {
  label: string;
  to: string;
}

export interface NotFoundProps {
  /**
   * Module-root shortcuts to show under the "Go home" CTA.
   * If omitted, only the "Go home" button is shown.
   */
  shortcuts?: NotFoundShortcut[];
  /** Where "Go home" navigates to. Defaults to "/". */
  homePath?: string;
}

/**
 * Catch-all "no route matched" view. Lifted from the home app (Bundle 4)
 * and unified across every app's `<Route path="*">` so a stray link or typo
 * surfaces as a visible error instead of a silent redirect — which masked
 * real routing bugs by bouncing users back to their last module.
 */
export function NotFound({ shortcuts, homePath = "/" }: NotFoundProps) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div style={{
      margin: "40px auto",
      maxWidth: 480,
      padding: 24,
      borderRadius: 8,
      boxShadow: "0 4px 12px 0 rgba(0, 0, 0, 0.15)",
      background: "white",
      textAlign: "center",
    }}>
      <h1 style={{ color: "var(--color-primary)", marginBottom: 8 }}>Page not found</h1>
      <p style={{ marginBottom: 16, color: "var(--color-text-subtle, #666)" }}>
        No route matches <code>{location.pathname}</code>.
      </p>
      <button
        type="button"
        onClick={() => navigate(homePath, { replace: true })}
        style={{
          padding: "8px 16px",
          border: "none",
          borderRadius: 6,
          background: "var(--color-primary)",
          color: "white",
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 500,
          minHeight: 44,
        }}
      >
        Go home
      </button>
      {shortcuts && shortcuts.length > 0 ? (
        <div style={{ marginTop: 16, fontSize: 13, color: "var(--color-text-subtle, #666)" }}>
          Or jump to{" "}
          {shortcuts.map((s, i) => (
            <span key={s.to}>
              <Link to={s.to}>{s.label}</Link>
              {i < shortcuts.length - 1 ? ", " : "."}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
