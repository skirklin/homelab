/**
 * Online/offline detection.
 *
 * `useOnline()` reports the browser's connectivity state. The hook updates
 * on `online` / `offline` events fired by the browser.
 *
 * `<OfflineBanner />` renders a thin sticky pill at the top of the viewport
 * when offline, so apps can mount it once and forget about it.
 */
import { useEffect, useState } from "react";

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        background: "#fff7e6",
        color: "#874d00",
        border: "1px solid #ffd591",
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
        boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
        pointerEvents: "none",
      }}
    >
      Offline — showing last synced data
    </div>
  );
}
