/**
 * Detect a horizontal swipe on a touch container and fire a callback.
 *
 * Returns `onTouchStart`/`onTouchEnd` handlers to spread onto an element. A
 * swipe fires only when the gesture is horizontal-dominant and long enough,
 * so vertical page scrolling never triggers it:
 *   - |dx| > THRESHOLD_PX  (enough horizontal travel)
 *   - |dx| > |dy| * RATIO  (clearly more horizontal than vertical)
 *
 * Single-finger only — multi-touch (pinch/zoom) is ignored. Touch handlers are
 * inert under a mouse, so no desktop gating is needed and we don't add
 * mouse-drag. A real swipe involves movement, so child `onClick`s (which need
 * near-zero movement) don't fire from it — keep these handlers on the content
 * wrapper, not on individual tappable cards.
 */
import { useRef, type TouchEvent } from "react";

const THRESHOLD_PX = 50;
const RATIO = 1.5;

export function useHorizontalSwipe(opts: {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      start.current = null;
      return;
    }
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY };
  };

  const onTouchEnd = (e: TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) <= THRESHOLD_PX) return;
    if (Math.abs(dx) <= Math.abs(dy) * RATIO) return;
    if (dx < 0) opts.onSwipeLeft?.();
    else opts.onSwipeRight?.();
  };

  // An interrupted gesture (e.g. system gesture takes over) must not leave a
  // stale start point that a later, unrelated touchend reads as a swipe.
  const onTouchCancel = () => {
    start.current = null;
  };

  return { onTouchStart, onTouchEnd, onTouchCancel };
}
