import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Popover, Segmented } from "antd";
import { ShareAltOutlined, LogoutOutlined, PlusOutlined, BellOutlined, BellFilled } from "@ant-design/icons";
import { AppHeader, ShareModal, useAuth, getBackend, useFeedback } from "@kirkl/shared";
import { useUpkeepContext } from "../upkeep-context";
import { useUserBackend } from "@kirkl/shared";
import { appStorage, StorageKeys } from "../storage";
import { isNotificationSupported, requestNotificationPermission, getFcmToken } from "../messaging";
import styled from "styled-components";
import type { NotificationMode } from "../types";

const NotificationPopover = styled.div`
  padding: var(--space-xs);
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
  const navigate = useNavigate();
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [notificationMode, setNotificationModeState] = useState<NotificationMode>("subscribed");
  const [loadingSettings, setLoadingSettings] = useState(true);

  const listId = state.list?.id || "";
  const shareUrl = `${window.location.origin}/join/${listId}`;
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
        title={listName}
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
