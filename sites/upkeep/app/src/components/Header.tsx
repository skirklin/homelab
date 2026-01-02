import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "antd";
import { ShareAltOutlined, LogoutOutlined, PlusOutlined } from "@ant-design/icons";
import { signOut } from "firebase/auth";
import { AppHeader, ShareModal } from "@kirkl/shared";
import { auth } from "../backend";
import { useUpkeepContext } from "../upkeep-context";
import { getCurrentListId } from "../firestore";
import { appStorage, StorageKeys } from "../storage";

interface HeaderProps {
  onAddTask: () => void;
  /** When true, hides account actions (handled by parent shell) */
  embedded?: boolean;
}

export function Header({ onAddTask, embedded = false }: HeaderProps) {
  const { state } = useUpkeepContext();
  const navigate = useNavigate();
  const [shareModalOpen, setShareModalOpen] = useState(false);

  const listId = getCurrentListId();
  const shareUrl = `${window.location.origin}/join/${listId}`;
  const listName = state.list?.name || "Tasks";

  const handleSignOut = async () => {
    await signOut(auth);
    navigate("..");
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

  // Share button as inline action
  const desktopActions = (
    <Button icon={<ShareAltOutlined />} onClick={() => setShareModalOpen(true)} />
  );

  // On mobile when embedded, show share button since there's no dropdown
  const mobileActions = embedded ? (
    <Button type="text" size="small" icon={<ShareAltOutlined />} onClick={() => setShareModalOpen(true)} />
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
