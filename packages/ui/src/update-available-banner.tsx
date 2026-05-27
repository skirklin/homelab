/**
 * <UpdateAvailableBanner />
 *
 * Sticky pill at the top of the viewport, shown once the browser has
 * installed a newer service worker for this page — i.e. a deploy landed
 * while the user had the tab open. Clicking reloads onto the fresh
 * bundle.
 *
 * Closes the "stale shell" footgun: between a deploy that adds/removes
 * a route and the SW activating + auto-reloading, an active user could
 * click a link routed through the OLD bundle and land on `<NotFound />`
 * (or a 404 on a deleted JS chunk). The banner gives the attentive user
 * an explicit, low-disruption way to opt onto the new build immediately;
 * the inattentive user is still covered by the `controllerchange`
 * auto-reload in `registerServiceWorker`.
 *
 * Styled to mirror `<OfflineBanner />` so the two stacking behaviors
 * stay coherent.
 */
import { useUpdateAvailable } from "./sw-register";
import { useOnline } from "./online-status";

export function UpdateAvailableBanner() {
  const updateAvailable = useUpdateAvailable();
  const online = useOnline();
  if (!updateAvailable) return null;
  // Stack below the OfflineBanner if both happen to be visible.
  const topInset = online ? "calc(8px + env(safe-area-inset-top))" : "calc(40px + env(safe-area-inset-top))";
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => window.location.reload()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          window.location.reload();
        }
      }}
      tabIndex={0}
      style={{
        position: "fixed",
        top: topInset,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        background: "#e6f4ff",
        color: "#0958d9",
        border: "1px solid #91caff",
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      Update available — tap to reload
    </div>
  );
}
