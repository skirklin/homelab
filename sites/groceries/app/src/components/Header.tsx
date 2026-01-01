import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Modal, Input, message, Dropdown } from "antd";
import type { MenuProps } from "antd";
import { LogoutOutlined, CheckOutlined, HistoryOutlined, ArrowLeftOutlined, SettingOutlined, ShareAltOutlined, MenuOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { signOut } from "firebase/auth";
import { getBackend } from "@kirkl/shared";
import { useGroceriesContext } from "../groceries-context";
import { clearCheckedItems } from "../firestore";
import { getItemsFromState } from "../subscription";
import { appStorage, StorageKeys } from "../storage";

const HeaderContainer = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
`;

const TitleSection = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const Title = styled.h1`
  font-size: var(--font-size-lg);
  margin: 0;
  color: var(--color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;

  @media (min-width: 480px) {
    font-size: var(--font-size-xl);
    max-width: none;
  }
`;

const DesktopActions = styled.div`
  display: none;
  gap: var(--space-sm);

  @media (min-width: 480px) {
    display: flex;
  }
`;

const MobileActions = styled.div`
  display: flex;
  gap: var(--space-xs);

  @media (min-width: 480px) {
    display: none;
  }
`;

const ModalForm = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
`;

const FormField = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
`;

const Label = styled.label`
  font-weight: 500;
  color: var(--color-text-secondary);
`;

interface Props {
  listId: string;
  onShowHistory: () => void;
  onShowSettings: () => void;
}

export function Header({ listId, onShowHistory, onShowSettings }: Props) {
  const navigate = useNavigate();
  const { state } = useGroceriesContext();
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const items = getItemsFromState(state);
  const checkedCount = items.filter((item) => item.checked).length;
  const listName = state.list?.name || "List";

  const joinLink = `${window.location.origin}/join/${listId}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(joinLink);
    message.success("Link copied!");
  };

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

  const menuItems: MenuProps["items"] = [
    { key: "share", icon: <ShareAltOutlined />, label: "Share", onClick: () => setShareModalOpen(true) },
    { key: "history", icon: <HistoryOutlined />, label: "History", onClick: onShowHistory },
    { key: "settings", icon: <SettingOutlined />, label: "Settings", onClick: onShowSettings },
    { type: "divider" },
    { key: "logout", icon: <LogoutOutlined />, label: "Sign Out", onClick: handleSignOut },
  ];

  return (
    <HeaderContainer>
      <TitleSection>
        <Button icon={<ArrowLeftOutlined />} onClick={() => {
          appStorage.remove(StorageKeys.LAST_LIST);
          navigate("..");
        }} size="small" type="text" />
        <Title>{listName}</Title>
      </TitleSection>

      {/* Desktop: show all buttons */}
      <DesktopActions>
        <Button icon={<ShareAltOutlined />} onClick={() => setShareModalOpen(true)} />
        <Button icon={<HistoryOutlined />} onClick={onShowHistory} />
        <Button icon={<SettingOutlined />} onClick={onShowSettings} />
        {checkedCount > 0 && (
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={handleDoneShopping}
          >
            Done ({checkedCount})
          </Button>
        )}
        <Button icon={<LogoutOutlined />} onClick={handleSignOut} />
      </DesktopActions>

      {/* Mobile: dropdown menu + Done button */}
      <MobileActions>
        {checkedCount > 0 && (
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={handleDoneShopping}
            size="small"
          >
            {checkedCount}
          </Button>
        )}
        <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
          <Button icon={<MenuOutlined />} size="small" />
        </Dropdown>
      </MobileActions>

      <Modal
        title={`Share "${listName}"`}
        open={shareModalOpen}
        onCancel={() => setShareModalOpen(false)}
        footer={null}
      >
        <ModalForm>
          <FormField>
            <Label>Share this link</Label>
            <Input
              value={joinLink}
              readOnly
              addonAfter={
                <Button type="text" size="small" onClick={handleCopyLink}>
                  Copy
                </Button>
              }
            />
          </FormField>
        </ModalForm>
      </Modal>
    </HeaderContainer>
  );
}
