/**
 * DateNav — the prev / date-display / next row plus the swipe-to-step
 * container, shared by the Log (capture) and Today (review) screens. Wraps a
 * `useSelectedDate()` instance; the parent owns the hook and passes it in so
 * both the nav chrome and the screen content read the same selected day.
 */
import { useCallback, useRef, type ReactNode } from "react";
import styled from "styled-components";
import { Button, DatePicker } from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useState } from "react";
import { startOfDay, type SelectedDate } from "../lib/useSelectedDate";

const DateNavRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  margin-bottom: var(--space-sm);
`;

const DateDisplay = styled.button`
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
  min-width: 120px;
  text-align: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-sm);

  &:hover {
    background: var(--color-bg-muted);
  }
`;

const HiddenDatePicker = styled(DatePicker)`
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  overflow: hidden;
`;

const NavButton = styled(Button)`
  &:disabled {
    opacity: 0.3;
  }
`;

const SwipeContainer = styled.div`
  touch-action: pan-y pinch-zoom;
  user-select: none;
`;

function formatPastLabel(d: Date): string {
  return dayjs(d).format("ddd, MMM D");
}

interface DateNavProps {
  date: SelectedDate;
  /** Content that lives inside the swipe surface (the screen body). */
  children: ReactNode;
}

export function DateNav({ date, children }: DateNavProps) {
  const {
    selectedDate,
    isToday,
    canGoNext,
    goToPrevDay,
    goToNextDay,
    updateSelectedDate,
    formatDateLabel,
  } = date;
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Swipe handling. Reserve the outer ~32px of each edge for the OS
  // back/forward gesture (iOS edge-swipe-back, Android edge-swipe-forward) so
  // our handler doesn't eat them.
  const touchStartX = useRef<number | null>(null);
  const EDGE_RESERVE_PX = 32;
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const x = e.touches[0].clientX;
    if (x < EDGE_RESERVE_PX || x > window.innerWidth - EDGE_RESERVE_PX) {
      touchStartX.current = null;
      return;
    }
    touchStartX.current = x;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (touchStartX.current === null) return;
      const touchEndX = e.changedTouches[0].clientX;
      const diff = touchStartX.current - touchEndX;
      const threshold = 50;
      if (Math.abs(diff) > threshold) {
        if (diff > 0 && canGoNext) {
          goToNextDay();
        } else if (diff < 0) {
          goToPrevDay();
        }
      }
      touchStartX.current = null;
    },
    [canGoNext, goToNextDay, goToPrevDay],
  );

  return (
    <>
      <DateNavRow>
        <NavButton type="text" icon={<LeftOutlined />} onClick={goToPrevDay} />
        <div style={{ position: "relative" }}>
          <DateDisplay
            onClick={() => {
              // On a past day the display is a "back to today" affordance; on
              // today it opens the picker for explicit date selection.
              if (isToday) {
                setDatePickerOpen(true);
              } else {
                updateSelectedDate(null);
              }
            }}
          >
            {formatDateLabel(formatPastLabel)}
          </DateDisplay>
          <HiddenDatePicker
            open={datePickerOpen}
            onOpenChange={setDatePickerOpen}
            value={dayjs(selectedDate)}
            onChange={(d) => {
              if (d && typeof (d as dayjs.Dayjs).toDate === "function") {
                updateSelectedDate(startOfDay((d as dayjs.Dayjs).toDate()));
              }
              setDatePickerOpen(false);
            }}
            disabledDate={(current) => current && (current as dayjs.Dayjs).isAfter(dayjs(), "day")}
          />
        </div>
        <NavButton
          type="text"
          icon={<RightOutlined />}
          onClick={goToNextDay}
          disabled={!canGoNext}
        />
      </DateNavRow>
      <SwipeContainer onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        {children}
      </SwipeContainer>
    </>
  );
}
