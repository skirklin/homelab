import { useEffect, useState } from "react";
import {
  isNotificationSupported,
  requestNotificationPermission,
  reconcilePushSubscription,
  disableNotifications,
} from "./push";

export interface PushToggle {
  /** Whether a live, server-acknowledged push subscription currently exists. */
  enabled: boolean;
  /** True while an on-mount reconcile or a `toggle` call is in flight. */
  loading: boolean;
  /** Whether this browser supports web push at all. */
  supported: boolean;
  /**
   * Enable (prompt + subscribe) or disable notifications. Resolves to the
   * resulting live-subscription state — `true` only when enabling succeeded.
   */
  toggle: (enabled: boolean) => Promise<boolean>;
}

/**
 * Boolean push-notification toggle for the simple "one switch" case.
 *
 * On mount it calls `reconcilePushSubscription()` (idempotent heal, never
 * prompts) and seeds `enabled` from the result, so the UI reflects the REAL
 * server state — `Notification.permission` staying "granted" after the backend
 * prunes the row can't be trusted on its own.
 *
 * `toggle(true)` prompts + subscribes; `toggle(false)` unsubscribes. The hook
 * is intentionally toast-free — wrap `toggle` if you want success/error
 * messages.
 */
export function usePushToggle(): PushToggle {
  const supported = isNotificationSupported();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(supported);

  useEffect(() => {
    if (!supported) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const live = await reconcilePushSubscription();
      if (!cancelled) {
        setEnabled(live);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const toggle = async (next: boolean): Promise<boolean> => {
    setLoading(true);
    try {
      const result = next ? await requestNotificationPermission() : false;
      if (!next) await disableNotifications();
      setEnabled(result);
      return result;
    } finally {
      setLoading(false);
    }
  };

  return { enabled, loading, supported, toggle };
}
