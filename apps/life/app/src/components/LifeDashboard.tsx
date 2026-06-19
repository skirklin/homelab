import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Switch, Tooltip } from "antd";
import {
  BellOutlined,
  SunOutlined,
  MoonOutlined,
  CheckCircleFilled,
  CalendarOutlined,
  PlusOutlined,
  HistoryOutlined,
} from "@ant-design/icons";
import {
  useAuth,
  PageContainer,
  SectionTitle,
  Section,
  AppHeader,
  useFeedback,
  SyncDot,
  useWpbDebug,
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
import { useSettingsMenu } from "../settings-menu";
import { GlobalQuickRow } from "./GlobalQuickRow";
import { HabitBoard } from "./HabitBoard";
import { ShapeSheet } from "./ShapeSheet";
import { SampleResponseModal } from "./SampleResponseModal";
import { DateNav } from "./DateNav";
import { SessionHistory } from "./SessionHistory";
import { Hint } from "./Hint";
import { RANDOM_SAMPLES } from "../manifest";
import { normalizeSessionRuns, type SessionView } from "@homelab/backend";
import { useViews } from "../lib/views";
import { userTz } from "../lib/useUserTz";
import { useTrackables, useGoals } from "../lib/trackables";
import { useSelectedDate, getDateString } from "../lib/useSelectedDate";
import { SHAPE_ORDER, SHAPE_META } from "../lib/shapes";
import type { TrackableShape } from "@homelab/backend";
import {
  initializeMessaging,
  requestNotificationPermission,
  disableNotifications,
  onForegroundMessage,
  listenForServiceWorkerMessages,
  getNotificationPermissionStatus,
} from "../messaging";
import { useLifeBackend } from "@kirkl/shared";

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
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  }
  return false;
}

const SessionRow = styled.div<{ $hasPrimary: boolean }>`
  display: grid;
  grid-template-columns: ${(p) => (p.$hasPrimary ? "1fr 1fr" : "1fr 1fr 1fr")};
  gap: var(--space-xs);
`;

/**
 * "+ Log something else" — the entry point for anything not on Favorites. A
 * toggle reveals the four shape options; each opens the existing per-shape
 * ShapeSheet (typeahead-to-pick-or-create + per-thing inputs + star-to-favorite).
 * Replaces the always-visible 2×2 ShapeCard grid.
 */
const LogMoreToggle = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  width: 100%;
  min-height: 48px;
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-primary);
  font-size: var(--font-size-base);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;

  .anticon { font-size: 14px; }

  &:hover { border-color: var(--color-primary); background: var(--color-bg-muted); }
`;

const ShapeGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-xs);
  margin-top: var(--space-xs);
`;

const ShapeButton = styled.button`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  min-height: 56px;
  transition: border-color 0.15s, background 0.15s;

  &:hover { border-color: var(--color-primary); background: var(--color-bg-muted); }
`;

const ShapeButtonTitle = styled.span`
  font-weight: 600;
  font-size: var(--font-size-base);
  color: var(--color-text);
`;

const ShapeButtonHint = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
`;

/**
 * The Sessions header's drill-into-history affordance — a subtle icon button
 * that sits next to the "Sessions" title and opens the SessionStreakGrid drawer.
 * Parallel to tapping a trackable's name on the board to open HabitHistory.
 */
const SessionsHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
`;

const HistoryButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  padding: 4px;
  margin: -4px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: color 0.15s;

  &:hover { color: var(--color-primary); }
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

export function LifeDashboard() {
  const { message } = useFeedback();
  const { user } = useAuth();
  const { state } = useLifeContext();
  const navigate = useNavigate();
  const life = useLifeBackend();
  const wpbDebug = useWpbDebug();
  // Settings/Sign Out now come from the shared header-menu fragment that
  // LifeRoutesInner provides (and which owns the single SettingsModal mount).
  const { menuItems } = useSettingsMenu();
  // Which shape's bottom sheet is open (null = closed).
  const [openShape, setOpenShape] = useState<TrackableShape | null>(null);
  // The "+ Log something else" shape picker (collapsed by default).
  const [logMoreOpen, setLogMoreOpen] = useState(false);
  // When the habit board backfills via the sheet, it passes the tapped day;
  // that overrides the viewed day so the sheet logs to the right bucket.
  const [shapeBackfillDay, setShapeBackfillDay] = useState<Date | null>(null);
  const openShapeForBackfill = useCallback((shape: TrackableShape, backfillDay?: Date) => {
    setShapeBackfillDay(backfillDay ?? null);
    setOpenShape(shape);
  }, []);
  const [showSampleModal, setShowSampleModal] = useState(false);
  // Session-history drill-down (parallel to HabitHistory): the Sessions header
  // opens this bottom drawer; the SessionCards keep their start-session onClick.
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  // Suppress the push-subscription affordance entirely on non-phone devices.
  const isMobile = useMemo(() => isMobileDevice(), []);

  // The viewed day + its `?date=` URL mirror, shared with the Today screen.
  const date = useSelectedDate();
  const { selectedDate, getSelectedTimestamp } = date;

  // Deep-link consume params (sample + quickResponse) — read on mount, then
  // scrubbed atomically in one history entry so neither survives a refresh.
  const [{ sample: sampleParam, quickResponse }, setDeepLinkParams] = useUrlParams<{
    sample: string | null;
    quickResponse: string | null;
  }>({
    sample: { parse: (raw) => raw, serialize: (v) => v, default: null },
    quickResponse: { parse: (raw) => raw, serialize: (v) => v, default: null },
  });

  // Entries subscription is mounted once in LifeRoutesInner so every route
  // inherits today's events from a single feed.
  const allEntries = Array.from(state.entries.values());

  // The vocabulary + goals come from the per-user manifest. The HabitBoard is
  // the day's review/check-off surface; favorites + "+ Log something else" are
  // the capture surfaces.
  const trackables = useTrackables();
  const goals = useGoals();

  // The session cards mirror the capture Views (morning / evening / weekly).
  // Each card navigates to the View's id (== its route slug) and reads its
  // greeting icon. Only the three default reflective views carry a card icon;
  // any custom view falls back to the calendar glyph.
  const views = useViews();

  // Only the three reflective views (morning/evening/weekly) render as session
  // cards. When none are present (Angela has `manifest.views = []`), suppress
  // the whole Sessions section — header included — so no orphaned heading shows.
  const sessionViews = useMemo(
    () => views.filter((v) => v.id === "morning" || v.id === "evening" || v.id === "weekly"),
    [views],
  );

  // Context-aware session prominence: drive sizing and ordering off the
  // current hour + day in the user's local tz. Also surface a "logged at
  // HH:MM" chip on whichever session was already done today.
  const sessionContext = useMemo(() => {
    const now = new Date();
    const hour = now.getHours();
    const isSunday = now.getDay() === 0;
    const todayKey = getDateString(now);

    // Find today's most recent run per view. A run is N per-item events
    // correlated by labels.view/view_run; normalize the stream and take each
    // view's latest run that falls on today.
    const lastByView: Record<SessionView, Date | null> = { morning: null, evening: null, weekly: null };
    for (const run of normalizeSessionRuns(allEntries)) {
      if (getDateString(run.timestamp) !== todayKey) continue;
      const prev = lastByView[run.view];
      if (!prev || run.timestamp > prev) lastByView[run.view] = run.timestamp;
    }

    // Layout decisions — at most one card is "primary":
    //   morning hours (0–11): morning primary
    //   Sunday afternoon/evening (12–21): weekly primary
    //   other afternoon/evening (12–21): evening primary
    //   late evening (22–23): all secondary
    type Prom = "primary" | "secondary";
    let primary: SessionView | null;
    if (hour < 12) {
      primary = "morning";
    } else if (hour < 22) {
      if (isSunday && !lastByView.weekly) {
        primary = "weekly";
      } else {
        primary = "evening";
      }
    } else {
      primary = null;
    }

    const sizeOf = (id: SessionView): Prom => (id === primary ? "primary" : "secondary");
    const orderOf = (id: SessionView): number => {
      if (id === primary) return 0;
      return id === "morning" ? 1 : id === "evening" ? 2 : 3;
    };

    return {
      hour,
      isSunday,
      lastByView,
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

  // Initialize messaging and listen for foreground messages.
  useEffect(() => {
    initializeMessaging();

    const unsubscribeForeground = onForegroundMessage(() => {
      setShowSampleModal(true);
    });

    const unsubscribeSW = listenForServiceWorkerMessages((data) => {
      if (data.type === "SAMPLE_REQUESTED") {
        setShowSampleModal(true);
      } else if (data.type === "QUICK_RESPONSE" && data.questionId && data.value !== undefined) {
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
  // and any other query state — via the react-router store.
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

  const samplingEnabled = RANDOM_SAMPLES.enabled;

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

  const desktopActions = samplingEnabled && isMobile ? (
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
  ) : undefined;

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
        {sessionViews.length > 0 && (
        <Section>
          <SessionsHeader>
            <SectionTitle>Sessions</SectionTitle>
            <HistoryButton
              type="button"
              onClick={() => setSessionHistoryOpen(true)}
              data-testid="session-history-open"
              aria-label="Session history"
            >
              <HistoryOutlined /> History
            </HistoryButton>
          </SessionsHeader>
          <SessionRow $hasPrimary={sessionContext.primary !== null}>
            {sessionViews
              .filter((v): v is typeof v & { id: SessionView } =>
                v.id === "morning" || v.id === "evening" || v.id === "weekly")
              // On Sundays the weekly review subsumes evening reflection — hide
              // the evening card entirely so the row reads "morning + weekly".
              // /evening is still reachable directly if needed.
              .filter((v) => !(sessionContext.isSunday && v.id === "evening"))
              .sort((a, b) => sessionContext.orderOf(a.id) - sessionContext.orderOf(b.id))
              .map((view) => {
                const size = sessionContext.sizeOf(view.id);
                const isPrimary = size === "primary";
                const logged = sessionContext.lastByView[view.id] ?? null;
                const isAfternoon = sessionContext.hour >= 12 && sessionContext.hour < 22;
                const muted =
                  sessionContext.lateNight ||
                  (view.id === "morning" && isAfternoon && !logged) ||
                  (view.id === "weekly" && !sessionContext.isSunday && !logged);
                const cardStyle = isPrimary ? { gridColumn: "1 / -1" } : undefined;
                const icon =
                  view.id === "morning" ? <SunOutlined />
                    : view.id === "evening" ? <MoonOutlined />
                      : <CalendarOutlined />;
                return (
                  <SessionCard
                    key={view.id}
                    $size={size}
                    $muted={muted}
                    style={cardStyle}
                    onClick={() => navigate(view.id)}
                  >
                    {icon}
                    <SessionCardTitle>{view.title}</SessionCardTitle>
                    {logged ? (
                      <SessionCardCheck>
                        <CheckCircleFilled /> logged at {formatHHmm(logged)}
                      </SessionCardCheck>
                    ) : view.id === "morning" && isAfternoon ? (
                      <Hint>missed earlier?</Hint>
                    ) : view.id === "weekly" && sessionContext.isSunday ? (
                      <Hint>Sunday review</Hint>
                    ) : null}
                  </SessionCard>
                );
              })}
          </SessionRow>
        </Section>
        )}

        <DateNav date={date}>
          <Section>
            <SectionTitle>Favorites</SectionTitle>
            <GlobalQuickRow
              trackables={trackables}
              userId={user?.uid ?? ""}
              logId={state.log?.id}
              timestamp={getSelectedTimestamp()}
            />
          </Section>

          <Section>
            <HabitBoard
              trackables={trackables}
              goals={goals}
              events={allEntries}
              day={selectedDate}
              userId={user?.uid ?? ""}
              logId={state.log?.id}
              onOpenShape={openShapeForBackfill}
            />
          </Section>

          <Section>
            <LogMoreToggle
              type="button"
              aria-expanded={logMoreOpen}
              onClick={() => setLogMoreOpen((o) => !o)}
              data-testid="log-more-toggle"
            >
              <PlusOutlined /> Log something else
            </LogMoreToggle>
            {logMoreOpen && (
              <ShapeGrid data-testid="log-more-shapes">
                {SHAPE_ORDER.map((shape) => (
                  <ShapeButton
                    key={shape}
                    type="button"
                    onClick={() => openShapeForBackfill(shape)}
                    data-testid={`log-shape-${shape}`}
                  >
                    <ShapeButtonTitle>{SHAPE_META[shape].title}</ShapeButtonTitle>
                    <ShapeButtonHint>{SHAPE_META[shape].hint}</ShapeButtonHint>
                  </ShapeButton>
                ))}
              </ShapeGrid>
            )}
          </Section>
        </DateNav>
      </PageContainer>

      <ShapeSheet
        shape={openShape}
        onClose={() => {
          setOpenShape(null);
          setShapeBackfillDay(null);
        }}
        trackables={trackables}
        events={allEntries}
        userId={user?.uid ?? ""}
        logId={state.log?.id}
        day={shapeBackfillDay ?? selectedDate}
      />

      <SessionHistory
        open={sessionHistoryOpen}
        onClose={() => setSessionHistoryOpen(false)}
        events={allEntries}
        tz={userTz()}
      />

      <SampleResponseModal
        open={showSampleModal}
        onClose={() => setShowSampleModal(false)}
        config={RANDOM_SAMPLES}
        userId={user?.uid ?? ""}
        logId={state.log?.id}
      />
    </>
  );
}
