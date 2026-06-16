/**
 * useSelectedDate — the `?date=YYYY-MM-DD` URL-as-source-of-truth day picker,
 * extracted from LifeDashboard so both the Log (capture) and Today (review)
 * screens can step the same viewed day with identical behavior.
 *
 * `selectedDate` (local state) is the INSTANT source of truth for the viewed
 * day — every interactive nav (prev/next/swipe/picker/back-to-today) calls
 * setSelectedDate synchronously, so stepping never round-trips through
 * react-router's async setSearchParams and can't race itself. The URL is a
 * lagging, debounced mirror used only for refresh/deep-link/browser-back.
 * `?date=YYYY-MM-DD` (browser-local) picks a day; no param means today.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useUrlParam } from "@kirkl/shared";
import { dayKey, zonedDateTime } from "@homelab/backend";
import { userTz } from "./useUserTz";

// The selected day's identity is the user-tz "YYYY-MM-DD" — the SAME key the
// day index / goal evaluator bucket by — so a picked day and the events shown
// for it agree even when the browser tz differs from the user's tz.
export function getDateString(date: Date): string {
  return dayKey(date, userTz());
}

// A stable representative instant for `date`'s user-tz day: local noon. Noon is
// robust to re-bucketing (any tz offset keeps it on the same date), and the
// value is only ever read back through tz-aware startOfDay/dayKey downstream.
export function startOfDay(date: Date): Date {
  return zonedDateTime(date, 12, 0, userTz());
}

// Serialize a Date to the `?date=` value, or null when it IS today (today =
// clean URL). This is the single function that defines what the URL "should"
// say for a given selectedDate, so the URL<->state reconcile below has one
// canonical comparison point and can't drift into a feedback loop.
function serializeSelectedDate(date: Date): string | null {
  return getDateString(date) === getDateString(new Date()) ? null : getDateString(date);
}

// Parse a YYYY-MM-DD string into a user-tz-noon representative instant. Returns
// null on malformed input or on dates outside the plausible range (year < 2000,
// or > tomorrow). "Tomorrow" is allowed so timezone edge cases at midnight don't
// trip users.
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseYmdParam(raw: string | null): Date | null {
  if (!raw) return null;
  const m = YMD_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Anchor at user-tz noon of the parsed calendar date. UTC-noon as the seed
  // lands on the right date in the user's tz for every real-world offset; the
  // round-trip check below rejects impossible dates (e.g. 2026-02-31, which
  // rolls into March).
  const seed = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  const d = zonedDateTime(seed, 12, 0, userTz());
  if (getDateString(d) !== raw) return null;
  const tomorrow = startOfDay(new Date());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d > tomorrow) return null;
  return d;
}

// Module-level so `parse`/`serialize` keep stable identities across renders.
// `useUrlParam`'s internal `commit` deps on `serialize` and `setValue` deps on
// `commit` — a fresh inline config each render would give `setDateParam` a new
// identity every render, making the URL-mirror effect re-run on EVERY render
// and clear+reschedule its 250ms debounce indefinitely while entries/chat/streak
// data streams in (a refresh mid-session could then restore the wrong day).
// `mode: "replace"` is passed explicitly so rapid day-stepping coalesces into a
// single history entry even if the hook's default ever changes.
const DATE_PARAM_OPTIONS = {
  parse: (raw: string | null) => raw,
  serialize: (v: string | null) => v,
  default: null,
  debounce: 250,
  mode: "replace" as const,
  // Day stepping (prev/next/swipe/picker/back-to-today) is an in-page content swap, not a
  // page-level navigation, so preserve the user's scroll position rather than jumping to top.
  preserveScroll: true,
};

export interface SelectedDate {
  selectedDate: Date;
  /** The raw `?date=` value (or null), for building query suffixes. */
  dateParam: string | null;
  /** True when the viewed day is today. */
  isToday: boolean;
  /** True when stepping forward is allowed (i.e. not already today). */
  canGoNext: boolean;
  goToPrevDay: () => void;
  goToNextDay: () => void;
  /** Jump to a day (or back to today). null = today. */
  updateSelectedDate: (date: Date | null) => void;
  /** Noon timestamp for the selected past day, or undefined for today. */
  getSelectedTimestamp: () => Date | undefined;
  /** "Today" / "Yesterday" / "ddd, MMM D" label — formatted by the caller. */
  formatDateLabel: (formatPast: (d: Date) => string) => string;
}

/**
 * Owns the viewed day for a capture/review screen: local state + a lagging,
 * debounced `?date=` URL mirror + midnight rollover. Two screens mounting this
 * hook each keep their own state but stay in sync via the shared URL param.
 */
export function useSelectedDate(): SelectedDate {
  const [dateParam, setDateParam] = useUrlParam<string | null>("date", DATE_PARAM_OPTIONS);
  const [selectedDate, setSelectedDate] = useState<Date>(
    () => parseYmdParam(dateParam) ?? startOfDay(new Date()),
  );
  // Latest selectedDate, read by the (rarely-rerun) midnight-rollover effect
  // without making it a dep — keeps its event listeners from re-registering on
  // every day step.
  const selectedDateRef = useRef(selectedDate);
  selectedDateRef.current = selectedDate;
  const [todayDate, setTodayDate] = useState<string>(() => getDateString(new Date()));

  // Mirror selectedDate INTO the URL (lagging, debounced, replace-mode). The
  // setter no-ops when the URL already matches, so this never fights an
  // external POP we just adopted (see the inbound-sync effect below).
  useEffect(() => {
    setDateParam(serializeSelectedDate(selectedDate));
  }, [selectedDate, setDateParam]);

  // Adopt EXTERNAL `?date=` changes into state: browser back/forward (POP) or
  // an inbound deep link whose param differs from what we'd serialize from the
  // current selection. Comparing against our own serialization is the loop
  // guard — when the param is just our own write echoing back, the strings
  // match and we skip.
  useEffect(() => {
    if (dateParam === serializeSelectedDate(selectedDate)) return;
    setSelectedDate(parseYmdParam(dateParam) ?? startOfDay(new Date()));
    // selectedDate intentionally omitted: this effect reacts to inbound URL
    // changes only. The serialize() comparison reads the latest closure value
    // each render, which suppresses the self-write echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateParam]);

  const updateSelectedDate = useCallback((date: Date | null) => {
    setSelectedDate(date === null ? startOfDay(new Date()) : startOfDay(date));
  }, []);

  // Midnight rollover: when the day flips, advance the view to the new "today"
  // — but ONLY if the user was sitting on the old "today". If they've navigated
  // to a specific past day, leave them there; they're looking at it on purpose.
  useEffect(() => {
    const checkDayChange = () => {
      const currentToday = getDateString(new Date());
      if (currentToday !== todayDate) {
        const wasOnToday = getDateString(selectedDateRef.current) === todayDate;
        setTodayDate(currentToday);
        if (wasOnToday) setSelectedDate(startOfDay(new Date()));
      }
    };

    const interval = setInterval(checkDayChange, 60000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") checkDayChange();
    };
    const handleFocus = () => checkDayChange();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [todayDate]);

  const isToday = getDateString(selectedDate) === getDateString(new Date());
  const canGoNext = !isToday;

  // Step via the FUNCTIONAL setState form so each step composes off the latest
  // pending value, never a stale closure — makes rapid prev/next race-free even
  // when several taps land in one React batch.
  const goToPrevDay = useCallback(() => {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() - 1);
      return next;
    });
  }, []);

  const goToNextDay = useCallback(() => {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + 1);
      if (next > startOfDay(new Date())) return prev;
      return next;
    });
  }, []);

  const getSelectedTimestamp = useCallback((): Date | undefined => {
    // `selectedDate` is already the user-tz noon representative of the picked
    // day (see startOfDay), so it IS the correct backfill anchor. Today → now.
    return isToday ? undefined : selectedDate;
  }, [isToday, selectedDate]);

  const formatDateLabel = useCallback(
    (formatPast: (d: Date) => string): string => {
      if (isToday) return "Today";
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      if (getDateString(selectedDate) === getDateString(yesterday)) return "Yesterday";
      return formatPast(selectedDate);
    },
    [isToday, selectedDate],
  );

  return {
    selectedDate,
    dateParam,
    isToday,
    canGoNext,
    goToPrevDay,
    goToNextDay,
    updateSelectedDate,
    getSelectedTimestamp,
    formatDateLabel,
  };
}
