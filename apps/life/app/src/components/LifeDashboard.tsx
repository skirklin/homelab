import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Switch, Tooltip, DatePicker } from "antd";
import { DownloadOutlined, BellOutlined, LogoutOutlined, LineChartOutlined, ControlOutlined, LeftOutlined, RightOutlined, SunOutlined, MoonOutlined, BookOutlined, CheckCircleFilled } from "@ant-design/icons";
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
import { WidgetRenderer } from "./widgets";
import { SampleResponseModal } from "./SampleResponseModal";
import { SettingsModal } from "./SettingsModal";
import { YearHeatmap, computeStreaks } from "./YearHeatmap";
import { MANIFEST, SESSIONS, sessionSubjectId, type Session } from "../manifest";
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

const NotificationToggle = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--font-size-sm);
`;

const DateNav = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
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

const SessionRow = styled.div`
  display: grid;
  /* Asymmetric grid: the prominent card stretches; the secondary stays
     narrower. Order is set per card via grid-column-start. */
  grid-template-columns: 2fr 1fr;
  gap: var(--space-sm);
`;

const SessionCard = styled.button<{ $size: "primary" | "secondary"; $muted: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  padding: ${(p) => (p.$size === "primary" ? "var(--space-lg) var(--space-md)" : "var(--space-sm) var(--space-md)")};
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

const SessionCardHint = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
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
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-sm);
`;

const StreakItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 110px;
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

const StreakBest = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  font-weight: 400;
  margin-left: 6px;
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

  // Track selected date and what "today" was when we loaded
  const [selectedDate, setSelectedDate] = useState<Date>(() => startOfDay(new Date()));
  const [todayDate, setTodayDate] = useState<string>(() => getDateString(new Date()));
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Swipe handling
  const touchStartX = useRef<number | null>(null);
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  // Check for day change - on interval, visibility change, and focus
  useEffect(() => {
    const checkDayChange = () => {
      const currentToday = getDateString(new Date());
      if (currentToday !== todayDate) {
        // If user was viewing "today", keep them on the new today
        const wasViewingToday = getDateString(selectedDate) === todayDate;
        setTodayDate(currentToday);
        if (wasViewingToday) {
          setSelectedDate(startOfDay(new Date()));
        }
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
  }, [todayDate, selectedDate]);

  // Navigation helpers
  const goToPrevDay = useCallback(() => {
    setSelectedDate(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() - 1);
      return newDate;
    });
  }, []);

  const goToNextDay = useCallback(() => {
    const tomorrow = startOfDay(new Date());
    tomorrow.setDate(tomorrow.getDate() + 1);

    setSelectedDate(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() + 1);
      // Don't go past today
      if (newDate > startOfDay(new Date())) {
        return startOfDay(new Date());
      }
      return newDate;
    });
  }, []);

  const isToday = getDateString(selectedDate) === getDateString(new Date());
  const canGoNext = !isToday;

  // Swipe handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
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

  const manifest = MANIFEST;
  const allEntries = Array.from(state.entries.values());

  // Streaks — recompute when entries change (Map identity flips on each
  // SET_ENTRIES dispatch, so the dep is stable enough).
  const morningStreaks = useMemo(() => computeStreaks(allEntries, "morning"), [state.entries]);
  const eveningStreaks = useMemo(() => computeStreaks(allEntries, "evening"), [state.entries]);

  // Context-aware session prominence: drive sizing and ordering off the
  // current hour in the user's local tz. Also surface a "logged at HH:MM"
  // chip on whichever session was already done today.
  const sessionContext = useMemo(() => {
    const now = new Date();
    const hour = now.getHours();
    const todayKey = getDateString(now);

    // Find today's most recent entry per session.
    const lastByKind: Record<Session["id"], Date | null> = { morning: null, evening: null };
    for (const e of allEntries) {
      if (getDateString(e.timestamp) !== todayKey) continue;
      for (const s of SESSIONS) {
        if (e.subjectId === sessionSubjectId(s.id)) {
          const prev = lastByKind[s.id];
          if (!prev || e.timestamp > prev) lastByKind[s.id] = e.timestamp;
        }
      }
    }

    // Layout decisions:
    //   morning hours (0–11): morning primary, evening secondary
    //   afternoon/evening (12–21): evening primary, morning secondary
    //   late evening (22–23): both secondary, no nudge
    type Prom = "primary" | "secondary";
    let morningSize: Prom;
    let eveningSize: Prom;
    let morningOrder: number;
    let eveningOrder: number;
    let lateNight = false;
    if (hour < 12) {
      morningSize = "primary";
      eveningSize = "secondary";
      morningOrder = 1;
      eveningOrder = 2;
    } else if (hour < 22) {
      morningSize = "secondary";
      eveningSize = "primary";
      // Evening on the left when it's prominent.
      eveningOrder = 1;
      morningOrder = 2;
    } else {
      morningSize = "secondary";
      eveningSize = "secondary";
      morningOrder = 1;
      eveningOrder = 2;
      lateNight = true;
    }

    return {
      hour,
      lastByKind,
      morningSize,
      eveningSize,
      morningOrder,
      eveningOrder,
      lateNight,
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

  // Handle quick response submission (from notification action buttons)
  const handleQuickResponse = useCallback(async (questionId: string, value: number) => {
    if (!user?.uid || !state.log?.id) {
      console.error("Cannot submit quick response: missing user or log");
      return;
    }
    try {
      await life.addSampleResponse(state.log.id, { [questionId]: value }, user.uid);
      message.success("Response saved");
    } catch (error) {
      console.error("Failed to save quick response:", error);
      message.error("Failed to save response");
    }
  }, [user?.uid, state.log?.id, life]);

  // Initialize messaging and listen for foreground messages
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

    // Check URL for sample or quick response parameters
    const params = new URLSearchParams(window.location.search);
    if (params.get("sample") === "true") {
      setShowSampleModal(true);
      // Clean up URL
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("quickResponse")) {
      // Handle quick response from URL (format: questionId:value)
      const quickResponse = params.get("quickResponse");
      const [questionId, valueStr] = quickResponse?.split(":") || [];
      if (questionId && valueStr) {
        handleQuickResponse(questionId, parseInt(valueStr, 10));
      }
      // Clean up URL
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => {
      unsubscribeForeground?.();
      unsubscribeSW?.();
    };
  }, [handleQuickResponse]);

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
      const headers = ["timestamp", "widget", "data", "source", "notes"];
      const rows = sortedEntries.map(e => [
        e.timestamp.toISOString(),
        e.subjectId,
        JSON.stringify(e.data),
        (e.data.source as string) || "manual",
        (e.data.notes as string) || "",
      ]);
      const csv = [headers.join(","), ...rows.map(r => r.map(c => `"${c}"`).join(","))].join("\n");
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

  const samplingEnabled = manifest.randomSamples?.enabled;

  const handleSignOut = () => {
    getBackend().authStore.clear();
  };

  // Menu items - always include Insights, Display, and Export for mobile access
  const menuItems = [
    { key: "journal", icon: <BookOutlined />, label: "Journal", onClick: () => navigate("journal") },
    { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate("insights") },
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
        onClick={() => navigate("journal")}
      >
        Journal
      </Button>
      <Button
        icon={<LineChartOutlined />}
        onClick={() => navigate("insights")}
      >
        Insights
      </Button>
      <Button
        icon={<ControlOutlined />}
        onClick={() => setShowSettings(true)}
      >
        Display
      </Button>
      {samplingEnabled && (
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

  const mobileActions = samplingEnabled ? (
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
          <SessionRow>
            {SESSIONS.map((session) => {
              const size =
                session.id === "morning"
                  ? sessionContext.morningSize
                  : session.id === "evening"
                    ? sessionContext.eveningSize
                    : "secondary";
              const order =
                session.id === "morning"
                  ? sessionContext.morningOrder
                  : session.id === "evening"
                    ? sessionContext.eveningOrder
                    : 3;
              const logged = sessionContext.lastByKind[session.id] ?? null;
              const isAfternoon = sessionContext.hour >= 12 && sessionContext.hour < 22;
              // Soft hint when morning was missed and we're now in afternoon —
              // invitations not nudges.
              const muted =
                sessionContext.lateNight ||
                (session.id === "morning" && isAfternoon && !logged);
              return (
                <SessionCard
                  key={session.id}
                  $size={size}
                  $muted={muted}
                  style={{ gridColumn: String(order) }}
                  onClick={() => navigate(session.id)}
                >
                  {session.id === "morning" ? <SunOutlined /> : <MoonOutlined />}
                  <SessionCardTitle>{session.title}</SessionCardTitle>
                  {logged ? (
                    <SessionCardCheck>
                      <CheckCircleFilled /> logged at {formatHHmm(logged)}
                    </SessionCardCheck>
                  ) : session.id === "morning" && isAfternoon ? (
                    <SessionCardHint>missed earlier?</SessionCardHint>
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
                  <StreakBest>best: {morningStreaks.longest}</StreakBest>
                )}
              </StreakValue>
            </StreakItem>
            <StreakItem>
              <StreakLabel><MoonOutlined /> Evening</StreakLabel>
              <StreakValue>
                {eveningStreaks.current} {eveningStreaks.current === 1 ? "day" : "days"}
                {eveningStreaks.longest > eveningStreaks.current && (
                  <StreakBest>best: {eveningStreaks.longest}</StreakBest>
                )}
              </StreakValue>
            </StreakItem>
          </StreakCard>
          <YearHeatmap entries={allEntries} />
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
              <DateDisplay onClick={() => setDatePickerOpen(true)}>
                {formatDateLabel()}
              </DateDisplay>
              <HiddenDatePicker
                open={datePickerOpen}
                onOpenChange={setDatePickerOpen}
                value={dayjs(selectedDate)}
                onChange={(date) => {
                  if (date && typeof (date as dayjs.Dayjs).toDate === 'function') {
                    setSelectedDate(startOfDay((date as dayjs.Dayjs).toDate()));
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
            <WidgetGrid>
              {manifest.widgets.map((widget) => (
                <WidgetRenderer
                  key={widget.id}
                  widget={widget}
                  entries={allEntries}
                  userId={user?.uid ?? ""}
                  logId={state.log?.id}
                  timestamp={getSelectedTimestamp()}
                  migrations={manifest.migrations}
                />
              ))}
            </WidgetGrid>
          </SwipeContainer>
        </Section>
      </PageContainer>

      <SampleResponseModal
        open={showSampleModal}
        onClose={() => setShowSampleModal(false)}
        config={manifest.randomSamples}
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
