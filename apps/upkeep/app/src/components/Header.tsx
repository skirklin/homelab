import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button, Popover, Segmented } from "antd";
import { ShareAltOutlined, LogoutOutlined, PlusOutlined, BellOutlined, BellFilled } from "@ant-design/icons";
import { AppHeader, ShareModal, useAuth, getBackend, useFeedback, SyncDot, useWpbDebug } from "@kirkl/shared";

/** Scope SyncDot to upkeep's collections so the dot reflects only this app. */
const UPKEEP_COLLECTIONS = ["task_lists", "tasks", "task_events"] as const;
import { useUpkeepContext } from "../upkeep-context";
import { useUserBackend } from "@kirkl/shared";
import { appStorage, StorageKeys } from "../storage";
import { isNotificationSupported, requestNotificationPermission, getFcmToken } from "../messaging";
import styled from "styled-components";
import type { NotificationMode } from "../types";

const NotificationPopover = styled.div`
  padding: var(--space-xs);
`;

const TitleWithStatus = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const PopoverTitle = styled.div`
  font-weight: 500;
  margin-bottom: var(--space-sm);
  color: var(--color-text);
`;

interface HeaderProps {
  onAddTask: () => void;
  /** When true, hides account actions (handled by parent shell) */
  embedded?: boolean;
}

export function Header({ onAddTask, embedded = false }: HeaderProps) {
  const { message } = useFeedback();
  const { state } = useUpkeepContext();
  const { user } = useAuth();
  const userBackend = useUserBackend();
  const wpbDebug = useWpbDebug();
  const navigate = useNavigate();
  const location = useLocation();
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [notificationMode, setNotificationModeState] = useState<NotificationMode>("subscribed");
  const [loadingSettings, setLoadingSettings] = useState(true);

  const listId = state.list?.id || "";
  // Derive the module base from the current pathname so the share link works
  // whether we're at `/upkeep/<slug>`, `/tasks/<slug>`, or the standalone
  // `upkeep.kirkl.in/<slug>`. Strip the trailing `/<slug>` to recover the
  // mount path (empty string when standalone, `/upkeep` or `/tasks` when
  // embedded). Falls through to `/join/<id>` for the standalone case.
  const moduleBase = location.pathname.replace(/\/[^/]*\/?$/, "");
  const shareUrl = `${window.location.origin}${moduleBase}/join/${listId}`;
  const listName = state.list?.name || "Tasks";

  // Load notification settings
  useEffect(() => {
    if (user) {
      userBackend.getNotificationMode(user.uid).then((mode) => {
        setNotificationModeState(mode);
        setLoadingSettings(false);
      });
    }
  }, [user, userBackend]);

  const handleSignOut = () => {
    getBackend().authStore.clear();
    navigate("..");
  };

  const handleModeChange = async (mode: NotificationMode) => {
    if (!user) return;

    // If enabling notifications, ensure we have permission and token
    if (mode !== "off") {
      if (!isNotificationSupported()) {
        message.warning("Notifications are not supported in this browser");
        return;
      }
      const permission = await requestNotificationPermission();
      if (permission !== "granted") {
        message.warning("Please allow notifications to receive reminders");
        return;
      }
      await getFcmToken(user.uid);
    }

    setNotificationModeState(mode);
    await userBackend.setNotificationMode(user.uid, mode);

    const messages: Record<NotificationMode, string> = {
      all: "You'll be notified for all tasks",
      subscribed: "You'll be notified for subscribed tasks only",
      off: "Notifications paused",
    };
    message.success(messages[mode]);
  };

  // When embedded, no dropdown menu - use inline buttons for actions
  // When standalone, show full menu including Sign Out
  const menuItems = embedded ? [] : [
    {
      key: "share",
      icon: <ShareAltOutlined />,
      label: "Share List",
      onClick: () => setShareModalOpen(true),
    },
    { type: "divider" as const },
    {
      key: "signout",
      icon: <LogoutOutlined />,
      label: "Sign Out",
      onClick: handleSignOut,
    },
  ];

  // Notification settings popover content
  const notificationContent = (
    <NotificationPopover>
      <PopoverTitle>Notifications</PopoverTitle>
      <Segmented
        value={notificationMode}
        onChange={(value) => handleModeChange(value as NotificationMode)}
        options={[
          { label: "All", value: "all" },
          { label: "Subscribed", value: "subscribed" },
          { label: "Off", value: "off" },
        ]}
        disabled={loadingSettings}
      />
    </NotificationPopover>
  );

  // Bell icon varies based on mode
  const bellIcon = notificationMode === "off" ? <BellOutlined /> : <BellFilled />;

  // Share and notifications buttons as inline actions
  const desktopActions = (
    <>
      <Popover content={notificationContent} trigger="click" placement="bottomRight">
        <Button icon={bellIcon} />
      </Popover>
      <Button icon={<ShareAltOutlined />} onClick={() => setShareModalOpen(true)} />
    </>
  );

  // On mobile when embedded, show share and notification buttons
  const mobileActions = embedded ? (
    <>
      <Popover content={notificationContent} trigger="click" placement="bottomRight">
        <Button type="text" size="small" icon={bellIcon} />
      </Popover>
      <Button type="text" size="small" icon={<ShareAltOutlined />} onClick={() => setShareModalOpen(true)} />
    </>
  ) : undefined;

  return (
    <>
      <AppHeader
        title={
          <TitleWithStatus>
            {listName}
            <SyncDot debug={wpbDebug} collections={UPKEEP_COLLECTIONS} />
          </TitleWithStatus>
        }
        onBack={() => {
          appStorage.remove(StorageKeys.LAST_LIST);
          navigate("..");
        }}
        primaryAction={{
          label: "Add Task",
          icon: <PlusOutlined />,
          onClick: onAddTask,
        }}
        menuItems={menuItems}
        desktopActions={desktopActions}
        mobileActions={mobileActions}
      />

      <ShareModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        title={`Share "${listName}"`}
        shareUrl={shareUrl}
        description="Share this link with others to let them join your task list:"
      />
    </>
  );
}
