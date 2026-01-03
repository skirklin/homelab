import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Switch, message, Tooltip } from "antd";
import { SettingOutlined, DownloadOutlined, BellOutlined, LogoutOutlined, LineChartOutlined, ControlOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons";
import { signOut } from "firebase/auth";
import dayjs from "dayjs";
import {
  useAuth,
  getBackend,
  PageContainer,
  SectionTitle,
  Section,
  WidgetGrid,
  AppHeader,
} from "@kirkl/shared";
import { useLife } from "../life-context";
import { useEntriesSubscription } from "../subscription";
import { WidgetRenderer } from "./widgets";
import { ManifestEditor } from "./ManifestEditor";
import { SampleResponseModal } from "./SampleResponseModal";
import { SettingsModal } from "./SettingsModal";
import type { LifeManifest } from "../types";
import { DEFAULT_MANIFEST } from "../types";
import {
  initializeMessaging,
  requestNotificationPermission,
  disableNotifications,
  onForegroundMessage,
  listenForServiceWorkerMessages,
  getNotificationPermissionStatus,
} from "../messaging";

// Helper to get date string for comparison (YYYY-MM-DD)
function getDateString(date: Date): string {
  return date.toISOString().split("T")[0];
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

const DateDisplay = styled.div`
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text);
  min-width: 120px;
  text-align: center;
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

interface LifeDashboardProps {
  /** When true, hides sign-out (handled by parent shell) */
  embedded?: boolean;
}

export function LifeDashboard({ embedded = false }: LifeDashboardProps) {
  const { user } = useAuth();
  const { state, dispatch } = useLife();
  const navigate = useNavigate();
  const [showManifestEditor, setShowManifestEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSampleModal, setShowSampleModal] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);

  // Track selected date and what "today" was when we loaded
  const [selectedDate, setSelectedDate] = useState<Date>(() => startOfDay(new Date()));
  const [todayDate, setTodayDate] = useState<string>(() => getDateString(new Date()));

  // Swipe handling
  const touchStartX = useRef<number | null>(null);
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  // Check for day change every minute
  useEffect(() => {
    const checkDayChange = () => {
      const currentToday = getDateString(new Date());
      if (currentToday !== todayDate) {
        setTodayDate(currentToday);
        // If user was viewing "today", keep them on the new today
        if (getDateString(selectedDate) === todayDate) {
          setSelectedDate(startOfDay(new Date()));
        }
      }
    };

    const interval = setInterval(checkDayChange, 60000); // Check every minute
    return () => clearInterval(interval);
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
  useEntriesSubscription(state.log?.id ?? null);

  const manifest = state.log?.manifest ?? DEFAULT_MANIFEST;
  const allEntries = Array.from(state.entries.values());

  // Check notification status on mount
  useEffect(() => {
    const status = getNotificationPermissionStatus();
    setNotificationsEnabled(status === "granted");
  }, []);

  // Initialize messaging and listen for foreground messages
  useEffect(() => {
    initializeMessaging();

    const unsubscribeForeground = onForegroundMessage(() => {
      setShowSampleModal(true);
    });

    const unsubscribeSW = listenForServiceWorkerMessages((data) => {
      if (data.type === "SAMPLE_REQUESTED") {
        setShowSampleModal(true);
      }
    });

    // Check URL for sample parameter
    const params = new URLSearchParams(window.location.search);
    if (params.get("sample") === "true") {
      setShowSampleModal(true);
      // Clean up URL
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => {
      unsubscribeForeground?.();
      unsubscribeSW?.();
    };
  }, []);

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

  const handleManifestUpdated = (updatedManifest: LifeManifest) => {
    dispatch({ type: "UPDATE_MANIFEST", manifest: updatedManifest });
  };

  const samplingEnabled = manifest.randomSamples?.enabled;

  const handleSignOut = () => {
    const { auth } = getBackend();
    signOut(auth);
  };

  // Menu items - always include Insights, Display, and Export for mobile access
  const menuItems = [
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
        title="Life Tracker"
        primaryAction={{
          label: "Configure",
          icon: <SettingOutlined />,
          onClick: () => setShowManifestEditor(true),
        }}
        menuItems={menuItems}
        desktopActions={desktopActions}
        mobileActions={mobileActions}
      />

      <PageContainer>
        <Section>
          <SectionTitle>Track</SectionTitle>
          <DateNav>
            <NavButton
              type="text"
              icon={<LeftOutlined />}
              onClick={goToPrevDay}
            />
            <DateDisplay>{formatDateLabel()}</DateDisplay>
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
                />
              ))}
            </WidgetGrid>
          </SwipeContainer>
        </Section>
      </PageContainer>

      <ManifestEditor
        open={showManifestEditor}
        onClose={() => setShowManifestEditor(false)}
        manifest={manifest}
        logId={state.log?.id}
        onManifestUpdated={handleManifestUpdated}
      />

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
      />
    </>
  );
}
