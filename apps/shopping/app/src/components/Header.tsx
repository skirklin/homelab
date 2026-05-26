import { useState } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Button } from "antd";
import { LogoutOutlined, CheckOutlined, HistoryOutlined, SettingOutlined, ShareAltOutlined } from "@ant-design/icons";
import { getBackend, AppHeader, ShareModal, SyncDot, useWpbDebug } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { useShoppingBackend } from "@kirkl/shared";
import { getItemsFromState } from "../selectors";
import { appStorage, StorageKeys } from "../storage";

/** Collections this app subscribes to. Used to scope the SyncDot so the
 *  shopping dot doesn't yellow because a write is pending in upkeep. */
const SHOPPING_COLLECTIONS = [
  "shopping_lists",
  "shopping_items",
  "shopping_trips",
] as const;

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
  const { state } = useShoppingContext();
  const shopping = useShoppingBackend();
  const wpbDebug = useWpbDebug();
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const items = getItemsFromState(state);
  const checkedCount = items.filter((item) => item.checked).length;
  const listName = state.list?.name || "List";

  const titleWithStatus = (
    <TitleWithStatus>
      {listName}
      <SyncDot debug={wpbDebug} collections={SHOPPING_COLLECTIONS} />
    </TitleWithStatus>
  );

  const shareUrl = `${window.location.origin}/join/${listId}`;

  const handleDoneShopping = () => {
    if (checkedCount === 0 || !listId) return;
    // Backend only needs the identifying + display fields; passing dates
    // tripped up items whose checkedAt/addedAt Date was invalid.
    const snapshot = items.map((item) => ({
      id: item.id,
      ingredient: item.ingredient,
      note: item.note || "",
      categoryId: item.categoryId,
      checked: item.checked,
    }));
    // Fire and forget — transient errors stay queued in wpb for automatic
    // retry on PB_CONNECT/focus, and permanent failures propagate as
    // unhandled WrappedPbError rejections that BackendProvider's global
    // useOptimisticErrorToast surfaces with a "Couldn't save" message. A
    // local try/catch + console.error here used to swallow both, which is
    // exactly the silent-data-loss shape the SyncDot work was trying to
    // eliminate.
    void shopping.clearCheckedItems(listId, snapshot);
  };

  const handleSignOut = () => {
    getBackend().authStore.clear();
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
