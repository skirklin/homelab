import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Switch, Tooltip } from "antd";
import { BellOutlined, LogoutOutlined, ControlOutlined, SunOutlined, MoonOutlined, CheckCircleFilled, CalendarOutlined } from "@ant-design/icons";
import {
  useAuth,
  getBackend,
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
import { GlobalQuickRow } from "./GlobalQuickRow";
import { ShapeCard } from "./ShapeCard";
import { ShapeSheet } from "./ShapeSheet";
import { SampleResponseModal } from "./SampleResponseModal";
import { SettingsModal } from "./SettingsModal";
import { DateNav } from "./DateNav";
import { Hint } from "./Hint";
import { RANDOM_SAMPLES, SESSIONS, sessionSubjectId, sessionPath, type Session } from "../manifest";
import { useTrackables } from "../lib/trackables";
import { useSelectedDate, getDateString } from "../lib/useSelectedDate";
import { SHAPE_ORDER } from "../lib/shapes";
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

const ShapeGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-xs);
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
  // Which shape's bottom sheet is open (null = closed).
  const [openShape, setOpenShape] = useState<TrackableShape | null>(null);
  const [showSampleModal, setShowSampleModal] = useState(false);
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

  // The vocabulary comes from the per-user manifest. Layout is by SHAPE (four
  // cards), not by group — `group` is a semantic rollup for trends.
  const trackables = useTrackables();

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
    const orderOf = (id: Session["id"]): number => {
      if (id === primary) return 0;
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

  // Export logic — the trigger UI lives in SettingsModal now (rare action), but
  // the data assembly stays here where `allEntries` is in scope.
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

  // Hamburger menu = RARE actions only. The 4 primary destinations live in the
  // bottom tab bar, not here. Settings (which now also hosts Export) + Sign Out.
  const menuItems = [
    { key: "settings", icon: <ControlOutlined />, label: "Settings", onClick: () => setShowSettings(true) },
    ...(!embedded ? [
      { type: "divider" as const },
      { key: "logout", icon: <LogoutOutlined />, label: "Sign Out", onClick: handleSignOut },
    ] : []),
  ];

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
        <Section>
          <SectionTitle>Sessions</SectionTitle>
          <SessionRow $hasPrimary={sessionContext.primary !== null}>
            {[...SESSIONS]
              // On Sundays the weekly review subsumes evening reflection — hide
              // the evening card entirely so the row reads "morning + weekly".
              // /evening is still reachable directly if needed.
              .filter((s) => !(sessionContext.isSunday && s.id === "evening"))
              .sort((a, b) => sessionContext.orderOf(a.id) - sessionContext.orderOf(b.id))
              .map((session) => {
                const size = sessionContext.sizeOf(session.id);
                const isPrimary = size === "primary";
                const logged = sessionContext.lastByKind[session.id] ?? null;
                const isAfternoon = sessionContext.hour >= 12 && sessionContext.hour < 22;
                const muted =
                  sessionContext.lateNight ||
                  (session.id === "morning" && isAfternoon && !logged) ||
                  (session.id === "weekly_review" && !sessionContext.isSunday && !logged);
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
          <SectionTitle>Track</SectionTitle>
          <DateNav date={date}>
            <GlobalQuickRow
              trackables={trackables}
              events={allEntries}
              userId={user?.uid ?? ""}
              logId={state.log?.id}
              timestamp={getSelectedTimestamp()}
            />
            <ShapeGrid>
              {SHAPE_ORDER.map((shape) => (
                <ShapeCard
                  key={shape}
                  shape={shape}
                  trackables={trackables}
                  events={allEntries}
                  day={selectedDate}
                  onOpen={setOpenShape}
                />
              ))}
            </ShapeGrid>
          </DateNav>
        </Section>
      </PageContainer>

      <ShapeSheet
        shape={openShape}
        onClose={() => setOpenShape(null)}
        trackables={trackables}
        events={allEntries}
        userId={user?.uid ?? ""}
        logId={state.log?.id}
        day={selectedDate}
      />

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
        onExport={handleExport}
        onResetSchedule={async () => {
          if (state.log?.id) {
            await life.clearSampleSchedule(state.log.id);
          }
        }}
      />
    </>
  );
}
