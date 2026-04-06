import { useState } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button } from "antd";
import { LogoutOutlined, CheckOutlined, HistoryOutlined, SettingOutlined, ShareAltOutlined } from "@ant-design/icons";
import { signOut } from "firebase/auth";
import { getBackend, AppHeader, ShareModal } from "@kirkl/shared";
import { useGroceriesContext } from "../groceries-context";
import { clearCheckedItems } from "../firestore";
import { getItemsFromState } from "../subscription";
import { appStorage, StorageKeys } from "../storage";
import { SyncIndicator } from "./SyncIndicator";

const TitleWithStatus = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

interface Props {
  listId: string;
  onShowHistory: () => void;
  onShowSettings: () => void;
  /** When true, hides sign-out (handled by parent shell) */
  embedded?: boolean;
}

export function Header({ listId, onShowHistory, onShowSettings, embedded = false }: Props) {
  const navigate = useNavigate();
  const { state } = useGroceriesContext();
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const items = getItemsFromState(state);
  const checkedCount = items.filter((item) => item.checked).length;
  const listName = state.list?.name || "List";

  const titleWithStatus = (
    <TitleWithStatus>
      {listName}
      <SyncIndicator status={state.syncStatus} />
    </TitleWithStatus>
  );

  const shareUrl = `${window.location.origin}/join/${listId}`;

  const handleDoneShopping = async () => {
    if (checkedCount === 0) return;
    try {
      await clearCheckedItems(items);
    } catch (error) {
      console.error("Failed to clear items:", error);
    }
  };

  const handleSignOut = () => {
    const { auth } = getBackend();
    signOut(auth);
  };

  // When embedded, no dropdown menu - use inline buttons for all actions
  // When standalone, show full menu including Sign Out
  const menuItems = embedded ? [] : [
    { key: "share", icon: <ShareAltOutlined />, label: "Share", onClick: () => setShareModalOpen(true) },
    { key: "history", icon: <HistoryOutlined />, label: "History", onClick: onShowHistory },
    { key: "settings", icon: <SettingOutlined />, label: "Settings", onClick: onShowSettings },
    { type: "divider" as const },
    { key: "logout", icon: <LogoutOutlined />, label: "Sign Out", onClick: handleSignOut },
  ];

  const desktopActions = (
    <>
      <Button icon={<ShareAltOutlined />} onClick={() => setShareModalOpen(true)} />
      <Button icon={<HistoryOutlined />} onClick={onShowHistory} />
      <Button icon={<SettingOutlined />} onClick={onShowSettings} />
    </>
  );

  // On mobile when embedded, show actions as buttons since there's no dropdown
  const mobileActions = embedded ? (
    <>
      <Button type="text" size="small" icon={<ShareAltOutlined />} onClick={() => setShareModalOpen(true)} />
      <Button type="text" size="small" icon={<HistoryOutlined />} onClick={onShowHistory} />
      <Button type="text" size="small" icon={<SettingOutlined />} onClick={onShowSettings} />
    </>
  ) : undefined;

  return (
    <>
      <AppHeader
        title={titleWithStatus}
        onBack={() => {
          appStorage.remove(StorageKeys.LAST_LIST);
          navigate("..");
        }}
        primaryAction={{
          label: `Done (${checkedCount})`,
          icon: <CheckOutlined />,
          onClick: handleDoneShopping,
          visible: checkedCount > 0,
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
      />
    </>
  );
}
