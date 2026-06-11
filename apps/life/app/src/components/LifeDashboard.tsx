import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Switch, Tooltip, DatePicker, Badge } from "antd";
import { DownloadOutlined, BellOutlined, LogoutOutlined, LineChartOutlined, ControlOutlined, LeftOutlined, RightOutlined, SunOutlined, MoonOutlined, BookOutlined, CheckCircleFilled, CalendarOutlined, RobotOutlined, MessageOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  useAuth,
  getBackend,
  PageContainer,
  SectionTitle,
  Section,
  WidgetGrid,
  AppHeader,
  useFeedback,
  SyncDot,
  useWpbDebug,
  useUrlParam,
  useUrlParams,
} from "@kirkl/shared";

/** Scope SyncDot to life's collections so a stuck write elsewhere doesn't
 *  yellow this app's indicator. */
const LIFE_COLLECTIONS = ["life_logs", "life_events"] as const;

const TitleWithStatus = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;
import { useLifeContext } from "../life-context";
import { EventLogger } from "./EventLogger";
import { GlobalQuickRow } from "./GlobalQuickRow";
import { SampleResponseModal } from "./SampleResponseModal";
import { SettingsModal } from "./SettingsModal";
import { SessionStreakGrid, computeStreaks } from "./SessionStreakGrid";
import { Hint } from "./Hint";
import { RANDOM_SAMPLES, SESSIONS, sessionSubjectId, sessionPath, type Session } from "../manifest";
import { useTrackables, GROUP_ORDER } from "../lib/trackables";
import type { LifeManifestTrackable } from "@homelab/backend";
import {
  initializeMessaging,
  requestNotificationPermission,
  disableNotifications,
  onForegroundMessage,
  listenForServiceWorkerMessages,
  getNotificationPermissionStatus,
} from "../messaging";
import { useLifeBackend, useChatBackend } from "@kirkl/shared";

// Helper to get date string for comparison (YYYY-MM-DD) in local timezone
function getDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Helper to get start of day
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Serialize a Date to the `?date=` value, or null when it IS today (today =
// clean URL). This is the single function that defines what the URL "should"
// say for a given selectedDate, so the URL<->state reconcile below has one
// canonical comparison point and can't drift into a feedback loop.
function serializeSelectedDate(date: Date): string | null {
  return getDateString(date) === getDateString(new Date()) ? null : getDateString(date);
}

// Parse a YYYY-MM-DD string in browser-local time. Returns null on malformed
// input or on dates outside the plausible range (year < 2000, or > tomorrow).
// "Tomorrow" is allowed so timezone edge cases at midnight don't trip users.
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseYmdParam(raw: string | null): Date | null {
  if (!raw) return null;
  const m = YMD_RE.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  // Round-trip check rejects things like 2026-02-31.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
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
};

const NotificationToggle = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--font-size-sm);
`;

/**
 * Best-effort "this is a phone or touch-tablet" check. Used to hide the push
 * notification opt-in on laptops/desktops — pushes there are noise the user
 * doesn't want, and a sub created here would otherwise enter the cron rotation.
 * Not reactive (won't flip if a mouse is paired mid-session); compute once.
 */
function isMobileDevice(): boolean {
  // Chromium Client Hints — authoritative when present.
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
  // Fallback for Safari/Firefox: primary input is touch and can't hover.
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  }
  return false;
}

const DateNav = styled.div`
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

const SessionRow = styled.div<{ $hasPrimary: boolean }>`
  display: grid;
  /* Two layouts:
     - With a primary card: it spans the full top row, the other two cards
       share an equal row below. Areas are wired via order on each card.
     - All-secondary (late night, or no time-of-day match): three equal
       columns in a single row. */
  grid-template-columns: ${(p) => (p.$hasPrimary ? "1fr 1fr" : "1fr 1fr 1fr")};
  gap: var(--space-xs);
`;

const GroupSection = styled.div`
  margin-bottom: var(--space-sm);

  &:last-child { margin-bottom: 0; }
`;

const GroupLabel = styled.div`
  font-size: var(--font-size-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
  margin-bottom: var(--space-xs);
  min-height: 1em; /* keep spacing consistent for unlabeled "more" group */
`;

const SessionCard = styled.button<{ $size: "primary" | "secondary"; $muted: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  padding: ${(p) => (p.$size === "primary" ? "var(--space-md) var(--space-sm)" : "var(--space-xs) var(--space-sm)")};
  background: var(--color-bg);
  border: ${(p) =>
    p.$size === "primary"
      ? "2px solid var(--color-primary)"
      : "1px solid var(--color-border)"};
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: ${(p) => (p.$size === "primary" ? "var(--font-size-lg)" : "var(--font-size-base)")};
  color: ${(p) => (p.$muted ? "var(--color-text-secondary)" : "var(--color-text)")};
  min-height: ${(p) => (p.$size === "primary" ? "92px" : "56px")};
  opacity: ${(p) => (p.$muted ? 0.7 : 1)};
  transition: background 0.15s, border-color 0.15s;

  .anticon {
    font-size: ${(p) => (p.$size === "primary" ? "28px" : "18px")};
    color: var(--color-primary);
  }

  &:hover {
    background: var(--color-bg-muted);
    border-color: var(--color-primary);
    opacity: 1;
  }
`;

const SessionCardTitle = styled.span`
  font-weight: 500;
`;

const SessionCardCheck = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-sm);
  color: var(--color-success, #52c41a);
  font-weight: 500;
`;

const StreakCard = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-xs);
`;

const StreakItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 110px; /* width for "longest: N day" text */
`;

const StreakLabel = styled.div`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;

  .anticon {
    color: var(--color-primary);
  }
`;

const StreakValue = styled.div`
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
`;

interface LifeDashboardProps {
  /** When true, hides sign-out (handled by parent shell) */
  embedded?: boolean;
}

export function LifeDashboard({ embedded = false }: LifeDashboardProps) {
  const { message } = useFeedback();
  const { user } = useAuth();
  const { state } = useLifeContext();
  const navigate = useNavigate();
  const life = useLifeBackend();
  const chat = useChatBackend();
  const wpbDebug = useWpbDebug();
  // Count of *unresolved* assistant messages whose kind needs a reply
  // (question / deploy_request). Refetched on mount + tab re-engagement so
  // the user sees an updated count after returning from /chat. v1 polls; a
  // realtime subscription is future work alongside C3 (push nudge).
  const [chatUnread, setChatUnread] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showSampleModal, setShowSampleModal] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  // Suppress the push-subscription affordance entirely on non-phone devices.
  const isMobile = useMemo(() => isMobileDevice(), []);

  // `selectedDate` (local state) is the INSTANT source of truth for the viewed
  // day — every interactive nav (prev/next/swipe/DatePicker/back-to-today)
  // calls setSelectedDate synchronously, so stepping never round-trips through
  // react-router's async setSearchParams and can't race itself. The URL is a
  // lagging, debounced mirror used only for refresh/deep-link/browser-back.
  // `?date=YYYY-MM-DD` (browser-local) picks a day; no param means today.
  //
  // The URL writer runs in `mode: "replace"` + debounced so rapid stepping
  // coalesces into a single history entry instead of N async commits.
  const [dateParam, setDateParam] = useUrlParam<string | null>("date", DATE_PARAM_OPTIONS);
  const [selectedDate, setSelectedDate] = useState<Date>(
    () => parseYmdParam(dateParam) ?? startOfDay(new Date()),
  );
  // Latest selectedDate, read by the (rarely-rerun) midnight-rollover effect
  // without making it a dep — keeps its event listeners from re-registering on
  // every day step.
  const selectedDateRef = useRef(selectedDate);
  selectedDateRef.current = selectedDate;
  // Deep-link consume params (sample + quickResponse) — read on mount, then
  // scrubbed atomically in one history entry so neither survives a refresh.
  const [{ sample: sampleParam, quickResponse }, setDeepLinkParams] = useUrlParams<{
    sample: string | null;
    quickResponse: string | null;
  }>({
    sample: { parse: (raw) => raw, serialize: (v) => v, default: null },
    quickResponse: { parse: (raw) => raw, serialize: (v) => v, default: null },
  });
  // todayDate ticks on midnight/visibility/focus so the rollover effect below
  // can advance `selectedDate` when the user is sitting on "today".
  const [todayDate, setTodayDate] = useState<string>(() => getDateString(new Date()));
  const [datePickerOpen, setDatePickerOpen] = useState(false);

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
  // match and we skip. A malformed param parses to null → falls back to today,
  // which the mirror effect then scrubs from the URL (no separate scrub effect
  // needed anymore).
  useEffect(() => {
    if (dateParam === serializeSelectedDate(selectedDate)) return;
    setSelectedDate(parseYmdParam(dateParam) ?? startOfDay(new Date()));
    // selectedDate is intentionally omitted: this effect reacts to inbound URL
    // changes only. The serialize() comparison reads the latest closure value
    // each render, which is sufficient to suppress the self-write echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateParam]);

  // Helper: jump to a day (or back to today). null = today. All interactive
  // nav (prev/next, DatePicker, swipes, "tap to return to today") goes through
  // setSelectedDate so the displayed value updates synchronously; the URL
  // follows via the mirror effect above.
  const updateSelectedDate = useCallback((date: Date | null) => {
    setSelectedDate(date === null ? startOfDay(new Date()) : startOfDay(date));
  }, []);

  // Swipe handling
  const touchStartX = useRef<number | null>(null);
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  // Midnight rollover: when the day flips, advance the view to the new "today"
  // — but ONLY if the user was sitting on the old "today". If they've navigated
  // to a specific past day, leave them there; they're looking at it on purpose.
  // We compare selectedDate against `todayDate` (the day as of the last tick),
  // not against the fresh `new Date()`, so "was the user on today?" is answered
  // relative to the day that just ended.
  useEffect(() => {
    const checkDayChange = () => {
      const currentToday = getDateString(new Date());
      if (currentToday !== todayDate) {
        const wasOnToday = getDateString(selectedDateRef.current) === todayDate;
        setTodayDate(currentToday);
        if (wasOnToday) setSelectedDate(startOfDay(new Date()));
      }
    };

    // Check periodically (backup for when app stays active)
    const interval = setInterval(checkDayChange, 60000);

    // Check when app becomes visible (handles mobile background/foreground)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkDayChange();
      }
    };

    // Check on window focus (handles tab switching)
    const handleFocus = () => {
      checkDayChange();
    };

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

  // Navigation helpers — step via the FUNCTIONAL setState form so each step
  // composes off the latest pending value, never a stale closure. This is what
  // makes rapid prev/next race-free even when several taps land in one React
  // batch (they'd otherwise all decrement the same render's selectedDate and
  // collapse to a single step). No URL round-trip; the mirror effect propagates
  // the settled day to ?date= for refresh/back/sharing.
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
      // Don't go past today.
      if (next > startOfDay(new Date())) return prev;
      return next;
    });
  }, []);

  // Swipe handlers. We reserve the outer ~32px of each edge for the OS
  // back/forward gesture (iOS edge-swipe-back, Android edge-swipe-forward) —
  // touches that start inside that band don't arm our day-step handler, so the
  // browser/OS gets to handle them. Apple's edge gesture region is ~28–32px
  // depending on device; 20px was too narrow and our handler kept eating the
  // back gesture. Fixed value (not env(safe-area-inset-*)) because clientX
  // is in the same viewport coordinate space — JS can't read the inset.
  const EDGE_RESERVE_PX = 32;
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const x = e.touches[0].clientX;
    if (x < EDGE_RESERVE_PX || x > window.innerWidth - EDGE_RESERVE_PX) {
      touchStartX.current = null;
      return;
    }
    touchStartX.current = x;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return;

    const touchEndX = e.changedTouches[0].clientX;
    const diff = touchStartX.current - touchEndX;
    const threshold = 50; // Minimum swipe distance

    if (Math.abs(diff) > threshold) {
      if (diff > 0 && canGoNext) {
        // Swiped left -> go to next day
        goToNextDay();
      } else if (diff < 0) {
        // Swiped right -> go to prev day
        goToPrevDay();
      }
    }

    touchStartX.current = null;
  }, [canGoNext, goToNextDay, goToPrevDay]);

  // Get timestamp for the selected date (noon to avoid timezone issues)
  const getSelectedTimestamp = (): Date | undefined => {
    if (isToday) return undefined; // Use current time for today
    const timestamp = new Date(selectedDate);
    timestamp.setHours(12, 0, 0, 0);
    return timestamp;
  };

  // Format the date for display
  const formatDateLabel = (): string => {
    if (isToday) return "Today";
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (getDateString(selectedDate) === getDateString(yesterday)) {
      return "Yesterday";
    }
    return dayjs(selectedDate).format("ddd, MMM D");
  };

  // Entries subscription is mounted once in LifeRoutesInner so every route
  // (dashboard, /morning, /evening, /weekly, /journal, /insights)
  // inherits today's events from a single feed.
  const allEntries = Array.from(state.entries.values());

  // Trackables come from the per-user manifest (falls back to the default
  // starter set). Group them for layout — unknown groups (or trackables
  // without a group) fall through to "more". `hidden` trackables are kept in
  // the manifest (so historical events still aggregate) but skipped here.
  const trackables = useTrackables();
  const grouped = trackables.filter((t) => !t.hidden).reduce<Record<string, LifeManifestTrackable[]>>((acc, t) => {
    const key = t.group ?? "more";
    (acc[key] ??= []).push(t);
    return acc;
  }, {});
  const groupKeys: string[] = [
    ...GROUP_ORDER.filter((k) => grouped[k]?.length),
    ...Object.keys(grouped).filter((k) => !(GROUP_ORDER as readonly string[]).includes(k)),
  ];

  // Streaks — recompute when entries change (Map identity flips on each
  // SET_ENTRIES dispatch, so the dep is stable enough).
  const morningStreaks = useMemo(() => computeStreaks(allEntries, "morning"), [state.entries]);
  const eveningStreaks = useMemo(() => computeStreaks(allEntries, "evening"), [state.entries]);

  // Context-aware session prominence: drive sizing and ordering off the
  // current hour + day in the user's local tz. Also surface a "logged at
  // HH:MM" chip on whichever session was already done today.
  const sessionContext = useMemo(() => {
    const now = new Date();
    const hour = now.getHours();
    const isSunday = now.getDay() === 0;
    const todayKey = getDateString(now);

    // Find today's most recent entry per session.
    const lastByKind: Record<Session["id"], Date | null> = { morning: null, evening: null, weekly_review: null };
    for (const e of allEntries) {
      if (getDateString(e.timestamp) !== todayKey) continue;
      for (const s of SESSIONS) {
        if (e.subjectId === sessionSubjectId(s.id)) {
          const prev = lastByKind[s.id];
          if (!prev || e.timestamp > prev) lastByKind[s.id] = e.timestamp;
        }
      }
    }

    // Layout decisions — at most one card is "primary":
    //   morning hours (0–11): morning primary
    //   Sunday afternoon/evening (12–21): weekly_review primary
    //   other afternoon/evening (12–21): evening primary
    //   late evening (22–23): all secondary
    // Once weekly_review is already logged today, fall back to evening on a
    // Sunday afternoon — no point pushing a done task as primary.
    type Prom = "primary" | "secondary";
    let primary: Session["id"] | null;
    if (hour < 12) {
      primary = "morning";
    } else if (hour < 22) {
      if (isSunday && !lastByKind.weekly_review) {
        primary = "weekly_review";
      } else {
        primary = "evening";
      }
    } else {
      primary = null;
    }

    const sizeOf = (id: Session["id"]): Prom => (id === primary ? "primary" : "secondary");
    // Order: primary card first (spans the full top row), then the
    // remaining cards in stable manifest order on the next row.
    const orderOf = (id: Session["id"]): number => {
      if (id === primary) return 0;
      // Stable secondary order: morning < evening < weekly_review.
      return id === "morning" ? 1 : id === "evening" ? 2 : 3;
    };

    return {
      hour,
      isSunday,
      lastByKind,
      primary,
      sizeOf,
      orderOf,
      lateNight: primary === null,
    };
  }, [allEntries, state.entries]);

  const formatHHmm = (d: Date) => {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m}${ampm}`;
  };

  // Check notification status on mount
  useEffect(() => {
    const status = getNotificationPermissionStatus();
    setNotificationsEnabled(status === "granted");
  }, []);

  // Chat unread badge — count unresolved assistant messages of kind
  // {question, deploy_request}. Fetched on mount + each visibility flip so a
  // returning user sees a current count without a hard refresh. Failures are
  // swallowed (the badge just shows 0).
  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        // Best-effort count, capped at the API route's hard ceiling (500;
        // see services/api/src/routes/chat.ts). The badge will silently
        // undercount only if a user has >500 unresolved assistant messages,
        // which means the PM cron has misbehaved for weeks; C3 (push nudge)
        // will obsolete this entire fetch path before that's a real risk.
        //
        // Scoped to the "pm" thread because the dashboard badge points the
        // user at /chat. Unresolved questions in observation threads
        // (`obs:<id>`) belong to /observations/:id and are surfaced there
        // separately; counting them in this badge would mislead the user
        // into clicking through to /chat and seeing nothing.
        const list = await chat.listMessages(user.uid, {
          threadId: "pm",
          resolved: false,
          limit: 500,
        });
        if (cancelled) return;
        const n = list.filter(
          (m) => m.role === "assistant" && (m.kind === "question" || m.kind === "deploy_request"),
        ).length;
        setChatUnread(n);
      } catch {
        // Quiet failure — the badge stays at the previous value (or 0 on first mount).
      }
    };
    fetchUnread();
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchUnread();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user?.uid, chat]);

  // Handle quick response submission (from notification action buttons).
  // questionId is the trackable id (all sample questions point at ratings).
  const handleQuickResponse = useCallback(async (questionId: string, value: number) => {
    if (!user?.uid || !state.log?.id) {
      console.error("Cannot submit quick response: missing user or log");
      return;
    }
    try {
      await life.addEvent(
        state.log.id,
        questionId,
        [{ name: "rating", type: "number", value, unit: "rating", scale: 5 }],
        user.uid,
        { labels: { source: "sample" } },
      );
      message.success("Response saved");
    } catch (error) {
      console.error("Failed to save quick response:", error);
      message.error("Failed to save response");
    }
  }, [user?.uid, state.log?.id, life, message]);

  // Initialize messaging and listen for foreground messages. Runs once: don't
  // wire searchParams in here or this re-registers on every URL change.
  useEffect(() => {
    initializeMessaging();

    const unsubscribeForeground = onForegroundMessage(() => {
      setShowSampleModal(true);
    });

    const unsubscribeSW = listenForServiceWorkerMessages((data) => {
      if (data.type === "SAMPLE_REQUESTED") {
        setShowSampleModal(true);
      } else if (data.type === "QUICK_RESPONSE" && data.questionId && data.value !== undefined) {
        // Auto-submit quick response from notification action button
        handleQuickResponse(data.questionId, data.value);
      }
    });

    return () => {
      unsubscribeForeground?.();
      unsubscribeSW?.();
    };
  }, [handleQuickResponse]);

  // Consume `?sample` / `?quickResponse` from the URL (deep-links from a push
  // notification action). Strip both params we consume — preserving `date`
  // and any other query state — via the react-router store so other
  // `useSearchParams()` readers see the scrubbed URL. Raw
  // `history.replaceState` would bypass the store and leave stale params.
  useEffect(() => {
    if (sampleParam !== "true" && !quickResponse) return;

    if (sampleParam === "true") {
      setShowSampleModal(true);
    } else if (quickResponse) {
      const [questionId, valueStr] = quickResponse.split(":");
      if (questionId && valueStr) {
        handleQuickResponse(questionId, parseInt(valueStr, 10));
      }
    }

    // Atomic multi-param scrub: both keys cleared in one history entry.
    setDeepLinkParams({ sample: null, quickResponse: null });
  }, [sampleParam, quickResponse, setDeepLinkParams, handleQuickResponse]);

  const handleNotificationToggle = async (enabled: boolean) => {
    if (!user?.uid) return;

    setNotificationLoading(true);
    try {
      if (enabled) {
        const success = await requestNotificationPermission(user.uid);
        if (success) {
          setNotificationsEnabled(true);
          message.success("Notifications enabled");
        } else {
          message.error("Failed to enable notifications");
        }
      } else {
        await disableNotifications(user.uid);
        setNotificationsEnabled(false);
        message.success("Notifications disabled");
      }
    } catch (error) {
      console.error("Failed to toggle notifications:", error);
      message.error("Failed to update notification settings");
    } finally {
      setNotificationLoading(false);
    }
  };

  const handleExport = (format: "csv" | "json") => {
    const sortedEntries = [...allEntries].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );

    if (format === "json") {
      const content = JSON.stringify(sortedEntries, null, 2);
      const date = new Date().toISOString().split("T")[0];
      downloadFile(content, `life-tracker-export-${date}.json`, "application/json");
      message.success("Exported to JSON");
    } else {
      // CSV is one row per event; the entries+labels payload renders as
      // compact JSON. Good enough for spreadsheets; the JSON export is the
      // structured surface.
      const headers = ["timestamp", "subject_id", "source", "entries", "labels"];
      const rows = sortedEntries.map(e => [
        e.timestamp.toISOString(),
        e.subjectId,
        e.labels?.source ?? "manual",
        JSON.stringify(e.entries),
        JSON.stringify(e.labels ?? {}),
      ]);
      const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
      const date = new Date().toISOString().split("T")[0];
      downloadFile(csv, `life-tracker-export-${date}.csv`, "text/csv");
      message.success("Exported to CSV");
    }
  };

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const samplingEnabled = RANDOM_SAMPLES.enabled;

  const handleSignOut = () => {
    getBackend().authStore.clear();
  };

  // Carry the current `?date=YYYY-MM-DD` (if any) through to Journal/Insights
  // so a tab switch doesn't lose the filter context. Relative `navigate()`
  // drops the existing query string, so build a suffix manually.
  const dateQuerySuffix = dateParam ? `?date=${encodeURIComponent(dateParam)}` : "";
  const journalTarget = `journal${dateQuerySuffix}`;
  const insightsTarget = `insights${dateQuerySuffix}`;

  // Menu items - always include Insights, Display, and Export for mobile access
  const menuItems = [
    { key: "journal", icon: <BookOutlined />, label: "Journal", onClick: () => navigate(journalTarget) },
    { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate(insightsTarget) },
    { key: "observations", icon: <RobotOutlined />, label: "Observations", onClick: () => navigate("/observations") },
    {
      key: "chat",
      icon: <MessageOutlined />,
      label: chatUnread > 0 ? `Chat (${chatUnread})` : "Chat",
      onClick: () => navigate("/chat"),
    },
    { key: "display", icon: <ControlOutlined />, label: "Display Settings", onClick: () => setShowSettings(true) },
    { type: "divider" as const },
    { key: "export-csv", icon: <DownloadOutlined />, label: "Export CSV", onClick: () => handleExport("csv") },
    { key: "export-json", icon: <DownloadOutlined />, label: "Export JSON", onClick: () => handleExport("json") },
    ...(!embedded ? [
      { type: "divider" as const },
      { key: "logout", icon: <LogoutOutlined />, label: "Sign Out", onClick: handleSignOut },
    ] : []),
  ];

  const desktopActions = (
    <>
      <Button
        icon={<BookOutlined />}
        onClick={() => navigate(journalTarget)}
      >
        Journal
      </Button>
      <Button
        icon={<LineChartOutlined />}
        onClick={() => navigate(insightsTarget)}
      >
        Insights
      </Button>
      <Button
        icon={<RobotOutlined />}
        onClick={() => navigate("/observations")}
      >
        Observations
      </Button>
      <Badge count={chatUnread} size="small" offset={[-4, 4]}>
        <Button
          icon={<MessageOutlined />}
          onClick={() => navigate("/chat")}
        >
          Chat
        </Button>
      </Badge>
      <Button
        icon={<ControlOutlined />}
        onClick={() => setShowSettings(true)}
      >
        Display
      </Button>
      {samplingEnabled && isMobile && (
        <Tooltip title={notificationsEnabled ? "Notifications on" : "Enable notifications for random sampling"}>
          <NotificationToggle>
            <BellOutlined />
            <Switch
              size="small"
              checked={notificationsEnabled}
              loading={notificationLoading}
              onChange={handleNotificationToggle}
            />
          </NotificationToggle>
        </Tooltip>
      )}
    </>
  );

  const mobileActions = samplingEnabled && isMobile ? (
    <NotificationToggle>
      <BellOutlined />
      <Switch
        size="small"
        checked={notificationsEnabled}
        loading={notificationLoading}
        onChange={handleNotificationToggle}
      />
    </NotificationToggle>
  ) : null;

  return (
    <>
      <AppHeader
        title={
          <TitleWithStatus>
            Life
            <SyncDot debug={wpbDebug} collections={LIFE_COLLECTIONS} />
          </TitleWithStatus>
        }
        menuItems={menuItems}
        desktopActions={desktopActions}
        mobileActions={mobileActions}
      />

      <PageContainer>
        <Section>
          <SectionTitle>Sessions</SectionTitle>
          <SessionRow $hasPrimary={sessionContext.primary !== null}>
            {[...SESSIONS]
              // On Sundays the weekly review subsumes evening reflection — hide
              // the evening card entirely so the row reads "morning + weekly"
              // instead of "morning + evening + weekly". /evening is still
              // reachable directly if needed.
              .filter((s) => !(sessionContext.isSunday && s.id === "evening"))
              .sort((a, b) => sessionContext.orderOf(a.id) - sessionContext.orderOf(b.id))
              .map((session) => {
                const size = sessionContext.sizeOf(session.id);
                const isPrimary = size === "primary";
                const logged = sessionContext.lastByKind[session.id] ?? null;
                const isAfternoon = sessionContext.hour >= 12 && sessionContext.hour < 22;
                // Soft hint for invitations not nudges. Morning gets the
                // "missed earlier?" hint after noon; weekly_review fades
                // when it's not Sunday (it's still tappable, just quieter).
                const muted =
                  sessionContext.lateNight ||
                  (session.id === "morning" && isAfternoon && !logged) ||
                  (session.id === "weekly_review" && !sessionContext.isSunday && !logged);
                // Primary spans the full row at the top; secondaries flow
                // into the second row in their natural order.
                const cardStyle = isPrimary ? { gridColumn: "1 / -1" } : undefined;
                const icon =
                  session.id === "morning" ? <SunOutlined />
                    : session.id === "evening" ? <MoonOutlined />
                      : <CalendarOutlined />;
                return (
                  <SessionCard
                    key={session.id}
                    $size={size}
                    $muted={muted}
                    style={cardStyle}
                    onClick={() => navigate(sessionPath(session.id))}
                  >
                    {icon}
                    <SessionCardTitle>{session.title}</SessionCardTitle>
                    {logged ? (
                      <SessionCardCheck>
                        <CheckCircleFilled /> logged at {formatHHmm(logged)}
                      </SessionCardCheck>
                    ) : session.id === "morning" && isAfternoon ? (
                      <Hint>missed earlier?</Hint>
                    ) : session.id === "weekly_review" && sessionContext.isSunday ? (
                      <Hint>Sunday review</Hint>
                    ) : null}
                  </SessionCard>
                );
              })}
          </SessionRow>
        </Section>

        <Section>
          <SectionTitle>Streaks</SectionTitle>
          <StreakCard>
            <StreakItem>
              <StreakLabel><SunOutlined /> Morning</StreakLabel>
              <StreakValue>
                {morningStreaks.current} {morningStreaks.current === 1 ? "day" : "days"}
                {morningStreaks.longest > morningStreaks.current && (
                  <Hint style={{ fontWeight: 400, marginLeft: 6 }}>best: {morningStreaks.longest}</Hint>
                )}
              </StreakValue>
            </StreakItem>
            <StreakItem>
              <StreakLabel><MoonOutlined /> Evening</StreakLabel>
              <StreakValue>
                {eveningStreaks.current} {eveningStreaks.current === 1 ? "day" : "days"}
                {eveningStreaks.longest > eveningStreaks.current && (
                  <Hint style={{ fontWeight: 400, marginLeft: 6 }}>best: {eveningStreaks.longest}</Hint>
                )}
              </StreakValue>
            </StreakItem>
          </StreakCard>
          <SessionStreakGrid entries={allEntries} />
        </Section>

        <Section>
          <SectionTitle>Track</SectionTitle>
          <DateNav>
            <NavButton
              type="text"
              icon={<LeftOutlined />}
              onClick={goToPrevDay}
            />
            <div style={{ position: "relative" }}>
              <DateDisplay
                onClick={() => {
                  // When viewing a past day, the display becomes a "back to
                  // today" affordance (clears the URL param). When already on
                  // today it opens the picker for explicit date selection.
                  if (isToday) {
                    setDatePickerOpen(true);
                  } else {
                    updateSelectedDate(null);
                  }
                }}
              >
                {formatDateLabel()}
              </DateDisplay>
              <HiddenDatePicker
                open={datePickerOpen}
                onOpenChange={setDatePickerOpen}
                value={dayjs(selectedDate)}
                onChange={(date) => {
                  if (date && typeof (date as dayjs.Dayjs).toDate === 'function') {
                    updateSelectedDate(startOfDay((date as dayjs.Dayjs).toDate()));
                  }
                  setDatePickerOpen(false);
                }}
                disabledDate={(current) => current && (current as dayjs.Dayjs).isAfter(dayjs(), 'day')}
              />
            </div>
            <NavButton
              type="text"
              icon={<RightOutlined />}
              onClick={goToNextDay}
              disabled={!canGoNext}
            />
          </DateNav>
          <SwipeContainer
            ref={swipeContainerRef}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <GlobalQuickRow
              trackables={trackables}
              entries={allEntries}
              userId={user?.uid ?? ""}
              logId={state.log?.id}
              timestamp={getSelectedTimestamp()}
            />
            {groupKeys.map((key) => (
              <GroupSection key={key}>
                <GroupLabel>{key === "more" ? "" : key}</GroupLabel>
                <WidgetGrid>
                  {grouped[key].map((trackable) => (
                    <EventLogger
                      key={trackable.id}
                      trackable={trackable}
                      entries={allEntries}
                      userId={user?.uid ?? ""}
                      logId={state.log?.id}
                      timestamp={getSelectedTimestamp()}
                    />
                  ))}
                </WidgetGrid>
              </GroupSection>
            ))}
          </SwipeContainer>
        </Section>
      </PageContainer>

      <SampleResponseModal
        open={showSampleModal}
        onClose={() => setShowSampleModal(false)}
        config={RANDOM_SAMPLES}
        userId={user?.uid ?? ""}
        logId={state.log?.id}
      />

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        log={state.log}
        userId={user?.uid}
        onResetSchedule={async () => {
          if (state.log?.id) {
            await life.clearSampleSchedule(state.log.id);
          }
        }}
      />
    </>
  );
}
