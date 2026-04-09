/**
 * Hook-based Ant Design feedback API (message, modal, notification).
 * Replaces static methods like Modal.confirm() and message.success()
 * which silently fail without an <App> ancestor in Ant Design v5.
 */
import { App } from "antd";

export function useFeedback() {
  return App.useApp();
}
