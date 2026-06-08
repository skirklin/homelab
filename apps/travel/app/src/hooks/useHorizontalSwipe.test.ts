import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHorizontalSwipe } from "./useHorizontalSwipe";

// Minimal fakes for the React TouchEvent shape the hook reads.
const touch = (x: number, y: number) => ({ clientX: x, clientY: y });
const startEvent = (...pts: ReturnType<typeof touch>[]) =>
  ({ touches: pts } as unknown as React.TouchEvent);
const endEvent = (...pts: ReturnType<typeof touch>[]) =>
  ({ changedTouches: pts } as unknown as React.TouchEvent);

function fire(
  handlers: { onTouchStart: (e: React.TouchEvent) => void; onTouchEnd: (e: React.TouchEvent) => void },
  from: ReturnType<typeof touch>,
  to: ReturnType<typeof touch>,
) {
  handlers.onTouchStart(startEvent(from));
  handlers.onTouchEnd(endEvent(to));
}

describe("useHorizontalSwipe", () => {
  it("fires onSwipeLeft for a leftward horizontal swipe", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() => useHorizontalSwipe({ onSwipeLeft, onSwipeRight }));
    fire(result.current, touch(200, 100), touch(100, 110));
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("fires onSwipeRight for a rightward horizontal swipe", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() => useHorizontalSwipe({ onSwipeLeft, onSwipeRight }));
    fire(result.current, touch(100, 100), touch(200, 90));
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("ignores a short horizontal move (below threshold)", () => {
    const onSwipeLeft = vi.fn();
    const { result } = renderHook(() => useHorizontalSwipe({ onSwipeLeft }));
    fire(result.current, touch(100, 100), touch(60, 100)); // dx = -40, ≤ 50
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("ignores a vertical-dominant drag (scrolling)", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() => useHorizontalSwipe({ onSwipeLeft, onSwipeRight }));
    fire(result.current, touch(100, 100), touch(160, 300)); // dx=60, dy=200 → vertical
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("ignores multi-touch gestures", () => {
    const onSwipeLeft = vi.fn();
    const { result } = renderHook(() => useHorizontalSwipe({ onSwipeLeft }));
    result.current.onTouchStart(startEvent(touch(200, 100), touch(210, 100)));
    result.current.onTouchEnd(endEvent(touch(100, 100)));
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("does not fire after a cancelled gesture", () => {
    const onSwipeLeft = vi.fn();
    const { result } = renderHook(() => useHorizontalSwipe({ onSwipeLeft }));
    result.current.onTouchStart(startEvent(touch(200, 100)));
    result.current.onTouchCancel();
    result.current.onTouchEnd(endEvent(touch(100, 110))); // would-be left swipe
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
