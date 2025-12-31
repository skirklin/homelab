import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Dropdown, Modal, Input, message } from "antd";
import { SettingOutlined, ShareAltOutlined, LogoutOutlined, ArrowLeftOutlined, PlusOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { signOut } from "firebase/auth";
import { auth } from "../backend";
import { useUpkeepContext } from "../upkeep-context";
import { useAuth } from "@kirkl/shared";
import { getCurrentListId } from "../firestore";
import { appStorage, StorageKeys } from "../storage";

const HeaderContainer = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  background: var(--color-primary);
  color: white;
  gap: var(--space-sm);
`;

const LeftSection = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const Title = styled.h1`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
`;

const RightSection = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const IconButton = styled(Button)`
  &&.ant-btn {
    color: white !important;
    background: transparent !important;
    border-color: rgba(255, 255, 255, 0.3) !important;

    .anticon {
      color: white !important;
    }

    &:hover {
      color: white !important;
      border-color: rgba(255, 255, 255, 0.6) !important;
      background: rgba(255, 255, 255, 0.1) !important;
    }
  }
`;

interface HeaderProps {
  onAddTask: () => void;
}

export function Header({ onAddTask }: HeaderProps) {
  const { state } = useUpkeepContext();
  const navigate = useNavigate();
  const [shareModalOpen, setShareModalOpen] = useState(false);

  const listId = getCurrentListId();
  const shareUrl = `${window.location.origin}/join/${listId}`;

  const handleCopyShareLink = () => {
    navigator.clipboard.writeText(shareUrl);
    message.success("Share link copied to clipboard");
    setShareModalOpen(false);
  };

  const handleSignOut = async () => {
    await signOut(auth);
    navigate(".");
  };

  const menuItems = [
    {
      key: "share",
      icon: <ShareAltOutlined />,
      label: "Share List",
      onClick: () => setShareModalOpen(true),
    },
    {
      type: "divider" as const,
    },
    {
      key: "signout",
      icon: <LogoutOutlined />,
      label: "Sign Out",
      onClick: handleSignOut,
    },
  ];

  return (
    <>
      <HeaderContainer>
        <LeftSection>
          <IconButton
            icon={<ArrowLeftOutlined />}
            onClick={() => {
              appStorage.remove(StorageKeys.LAST_LIST);
              navigate(".");
            }}
          />
          <Title>{state.list?.name || "Tasks"}</Title>
        </LeftSection>
        <RightSection>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={onAddTask}
            style={{ background: "rgba(255,255,255,0.2)", borderColor: "transparent" }}
          >
            Add Task
          </Button>
          <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
            <IconButton icon={<SettingOutlined />} />
          </Dropdown>
        </RightSection>
      </HeaderContainer>

      <Modal
        title="Share This List"
        open={shareModalOpen}
        onCancel={() => setShareModalOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setShareModalOpen(false)}>
            Cancel
          </Button>,
          <Button key="copy" type="primary" onClick={handleCopyShareLink}>
            Copy Link
          </Button>,
        ]}
      >
        <p>Share this link with others to let them join your task list:</p>
        <Input value={shareUrl} readOnly />
      </Modal>
    </>
  );
}
