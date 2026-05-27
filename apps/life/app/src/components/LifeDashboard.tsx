import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import styled from "styled-components";
import { Button, Switch, Tooltip, DatePicker } from "antd";
import { DownloadOutlined, BellOutlined, LogoutOutlined, LineChartOutlined, ControlOutlined, LeftOutlined, RightOutlined, SunOutlined, MoonOutlined, BookOutlined, CheckCircleFilled, CalendarOutlined } from "@ant-design/icons";
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
import { useEntriesSubscription } from "../subscription";
import { EventLogger } from "./EventLogger";
import { SampleResponseModal } from "./SampleResponseModal";
import { SettingsModal } from "./SettingsModal";
import { SessionStreakGrid, computeStreaks } from "./SessionStreakGrid";
import { Hint } from "./Hint";
import { TRACKABLES, GROUP_ORDER, RANDOM_SAMPLES, SESSIONS, sessionSubjectId, sessionPath, type Trackable, type Session } from "../manifest";
import {
  initializeMessaging,
  requestNotificationPermission,
  disableNotifications,
  onForegroundMessage,
  listenForServiceWorkerMessages,
  getNotificationPermissionStatus,
} from "../messaging";
import { useLifeBackend } from "@kirkl/shared";

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
  const wpbDebug = useWpbDebug();
  const [showSettings, setShowSettings] = useState(false);
  const [showSampleModal, setShowSampleModal] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  // Suppress the push-subscription affordance entirely on non-phone devices.
  const isMobile = useMemo(() => isMobileDevice(), []);

  // The URL is the source of truth for the viewed day. `?date=YYYY-MM-DD`
  // (browser-local time) picks a specific day; no param means today.
  const [searchParams, setSearchParams] = useSearchParams();
  const [dateParam, setDateParam] = useUrlParam<string | null>("date", {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
  });
  // todayDate ticks on midnight/visibility/focus so the derived value below
  // re-evaluates "today" without needing to write to the URL.
  const [todayDate, setTodayDate] = useState<string>(() => getDateString(new Date()));
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Derive selectedDate from the URL. Invalid params fall back to today and
  // are scrubbed by the effect below. todayDate is a dep so the rollover
  // effect re-derives "today" when the day flips at midnight.
  const selectedDate = useMemo<Date>(() => {
    const parsed = parseYmdParam(dateParam);
    return parsed ?? startOfDay(new Date());
    // todayDate intentionally listed so midnight rollover re-derives today.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateParam, todayDate]);

  // Quietly scrub a malformed `?date=...` so URLs don't carry garbage.
  useEffect(() => {
    if (!dateParam) return;
    if (parseYmdParam(dateParam) !== null) return;
    setDateParam(null);
  }, [dateParam, setDateParam]);

  // Helper: write the URL. null clears the param (back to "today" with a
  // clean URL); a Date writes ?date=YYYY-MM-DD. Used by prev/next, the
  // DatePicker, swipes, and the "tap to return to today" affordance.
  const updateSelectedDate = useCallback(
    (date: Date | null) => {
      setDateParam(date === null ? null : getDateString(date));
    },
    [setDateParam],
  );

  // Swipe handling
  const touchStartX = useRef<number | null>(null);
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  // Midnight rollover: when the day flips, re-derive "today" so the dashboard
  // (with no `?date` param) silently advances. When the user has `?date=...`
  // explicitly set, leave them on that day — they're looking at it on purpose.
  useEffect(() => {
    const checkDayChange = () => {
      const currentToday = getDateString(new Date());
      if (currentToday !== todayDate) {
        setTodayDate(currentToday);
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

  // Navigation helpers — all writes go through the URL so refresh/back/forward
  // and link-sharing all do the right thing.
  const goToPrevDay = useCallback(() => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() - 1);
    updateSelectedDate(newDate);
  }, [selectedDate, updateSelectedDate]);

  const goToNextDay = useCallback(() => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + 1);
    // Don't go past today
    if (newDate > startOfDay(new Date())) return;
    updateSelectedDate(newDate);
  }, [selectedDate, updateSelectedDate]);

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

  // Subscribe to entries
  const logId = state.log?.id ?? null;
  useEntriesSubscription(logId);

  const allEntries = Array.from(state.entries.values());

  // Group trackables for layout. Unknown groups (or trackables without a
  // group) fall through to "more". `hidden` trackables are kept in the
  // manifest (so historical events still aggregate) but skipped here.
  const grouped = TRACKABLES.filter((t) => !t.hidden).reduce<Record<string, Trackable[]>>((acc, t) => {
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
  // notification action). Strip only the params we consume — preserving
  // `date` and any other query state — via the react-router store so other
  // `useSearchParams()` readers see the scrubbed URL. Raw
  // `history.replaceState` would bypass the store and leave stale params.
  useEffect(() => {
    const sampleParam = searchParams.get("sample");
    const quickResponse = searchParams.get("quickResponse");
    if (sampleParam !== "true" && !quickResponse) return;

    if (sampleParam === "true") {
      setShowSampleModal(true);
    } else if (quickResponse) {
      const [questionId, valueStr] = quickResponse.split(":");
      if (questionId && valueStr) {
        handleQuickResponse(questionId, parseInt(valueStr, 10));
      }
    }

    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("sample");
        next.delete("quickResponse");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, handleQuickResponse]);

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
