/**
 * Press-and-hold hook for calendar cells. Distinguishes a SHORT tap from a
 * LONG press (press-and-hold ~450ms) over pointer events, and is careful not to
 * fire BOTH for one gesture:
 *
 *   - onPointerDown arms a timer; if it elapses before release, the long-press
 *     fires and a flag suppresses the trailing tap.
 *   - onPointerUp before the timer → a short tap fires (unless the long-press
 *     already did).
 *   - any movement past a small slop, or a scroll/cancel, aborts the gesture
 *     entirely (no tap, no long-press) so vertical scrolling never trips a tap.
 *
 * Works for both touch and mouse (pointer events unify them). Returns the
 * handlers to spread onto the cell; the cell stays a normal button (Enter/Space
 * still trigger onClick if the caller also wires it — here taps come through the
 * pointer path, so callers should NOT also pass onClick to avoid a double-fire).
 */
import { useCallback, useRef } from "react";

/** Press duration (ms) that promotes a tap into a long-press. */
const LONG_PRESS_MS = 450;
/** Movement (px) past which the gesture is treated as a scroll/drag, not a tap. */
const MOVE_SLOP_PX = 10;

export interface PressHoldHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  /** Suppress the synthesized click so a long-press never also taps. */
  onClick: (e: React.MouseEvent) => void;
}

/**
 * @param onTap       fires on a short tap (release before the long-press timer)
 * @param onLongPress fires once the hold passes LONG_PRESS_MS
 * @param disabled    when true, no gesture fires (future cells)
 */
export function usePressHold(
  onTap: () => void,
  onLongPress: () => void,
  disabled = false,
): PressHoldHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedLong = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  // True between a real long-press firing and the next pointerdown — used to
  // swallow the trailing synthetic click on mouse.
  const suppressClick = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      firedLong.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = setTimeout(() => {
        firedLong.current = true;
        suppressClick.current = true;
        timer.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [disabled, clear, onLongPress],
  );

  const abort = useCallback(() => {
    clear();
    start.current = null;
  }, [clear]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || !start.current) return;
      const dx = Math.abs(e.clientX - start.current.x);
      const dy = Math.abs(e.clientY - start.current.y);
      if (dx > MOVE_SLOP_PX || dy > MOVE_SLOP_PX) abort();
    },
    [disabled, abort],
  );

  const onPointerUp = useCallback(
    () => {
      if (disabled) return;
      const armed = start.current !== null;
      clear();
      start.current = null;
      // A long-press already handled this gesture, or movement aborted it.
      if (firedLong.current || !armed) return;
      onTap();
    },
    [disabled, clear, onTap],
  );

  const onPointerLeave = useCallback(() => {
    if (disabled) return;
    abort();
  }, [disabled, abort]);

  const onClick = useCallback((e: React.MouseEvent) => {
    // Pointer path owns tap/long-press; swallow the synthetic click so a
    // long-press doesn't also register as a tap on mouse.
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  return {
    onPointerDown,
    onPointerUp,
    onPointerMove,
    onPointerLeave,
    onPointerCancel: onPointerLeave,
    onClick,
  };
}
