import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button, Dropdown, Switch, message, Tooltip, DatePicker } from "antd";
import { SettingOutlined, DownloadOutlined, BellOutlined, LogoutOutlined, LineChartOutlined, ControlOutlined } from "@ant-design/icons";
import { signOut } from "firebase/auth";
import dayjs from "dayjs";
import {
  useAuth,
  getBackend,
  PageContainer,
  SectionHeader,
  SectionTitle,
  Section,
  ActionGroup,
  WidgetGrid,
  AppHeader,
} from "@kirkl/shared";
import { useLife } from "../life-context";
import { useEntriesSubscription } from "../subscription";
import { WidgetRenderer } from "./widgets";
import { RecentEntries } from "./RecentEntries";
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

const NotificationToggle = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--font-size-sm);
`;

const DateSelector = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
  flex-wrap: wrap;
`;

const DateLabel = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const DateButton = styled(Button)<{ $active?: boolean }>`
  ${props => props.$active && `
    background: var(--color-primary);
    color: white;
    border-color: var(--color-primary);

    &:hover {
      background: var(--color-primary);
      color: white;
      border-color: var(--color-primary);
      opacity: 0.9;
    }
  `}
`;

type DateMode = "today" | "yesterday" | "custom";

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
  const [dateMode, setDateMode] = useState<DateMode>("today");
  const [customDate, setCustomDate] = useState<dayjs.Dayjs | null>(null);

  const getSelectedTimestamp = (): Date | undefined => {
    if (dateMode === "today") return undefined; // Use current time
    if (dateMode === "yesterday") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(12, 0, 0, 0); // Noon yesterday
      return yesterday;
    }
    if (dateMode === "custom" && customDate) {
      return customDate.toDate();
    }
    return undefined;
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

  const exportMenuItems = [
    { key: "csv", label: "Export as CSV", onClick: () => handleExport("csv") },
    { key: "json", label: "Export as JSON", onClick: () => handleExport("json") },
  ];

  const handleManifestUpdated = (updatedManifest: LifeManifest) => {
    dispatch({ type: "UPDATE_MANIFEST", manifest: updatedManifest });
  };

  const recentEntries = [...allEntries]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 20);

  const samplingEnabled = manifest.randomSamples?.enabled;

  const handleSignOut = () => {
    const { auth } = getBackend();
    signOut(auth);
  };

  // Menu items - always include Insights and Display for mobile access
  const menuItems = [
    { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate("insights") },
    { key: "display", icon: <ControlOutlined />, label: "Display Settings", onClick: () => setShowSettings(true) },
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
        <DateSelector>
          <DateLabel>Log for:</DateLabel>
          <DateButton
            size="small"
            $active={dateMode === "today"}
            onClick={() => { setDateMode("today"); setCustomDate(null); }}
          >
            Today
          </DateButton>
          <DateButton
            size="small"
            $active={dateMode === "yesterday"}
            onClick={() => { setDateMode("yesterday"); setCustomDate(null); }}
          >
            Yesterday
          </DateButton>
          <DatePicker
            size="small"
            value={customDate}
            onChange={(date) => {
              if (date) {
                setCustomDate(date);
                setDateMode("custom");
              } else {
                setCustomDate(null);
                setDateMode("today");
              }
            }}
            onOpenChange={(open) => {
              // When picker opens without a value, default to 2 days ago
              if (open && !customDate) {
                const twoDaysAgo = dayjs().subtract(2, 'day');
                setCustomDate(twoDaysAgo);
              }
            }}
            disabledDate={(current) => current && current.isAfter(dayjs(), 'day')}
            format="MMM D"
            allowClear
            placeholder="Other"
            style={{ width: 95 }}
          />
        </DateSelector>
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
      </Section>

      <Section>
        <SectionHeader>
          <SectionTitle>Recent Entries</SectionTitle>
          <ActionGroup>
            <Dropdown menu={{ items: exportMenuItems }} trigger={["click"]}>
              <Button icon={<DownloadOutlined />}>Export</Button>
            </Dropdown>
          </ActionGroup>
        </SectionHeader>
        <RecentEntries
          entries={recentEntries}
          manifest={manifest}
          logId={state.log?.id}
        />
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
