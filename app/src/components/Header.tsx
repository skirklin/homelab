import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Modal, Input, message } from "antd";
import { LogoutOutlined, CheckOutlined, HistoryOutlined, UnorderedListOutlined, SettingOutlined, ShareAltOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { signOut } from "firebase/auth";
import { auth } from "../backend";
import { useAppContext } from "../context";
import { clearCheckedItems } from "../firestore";
import { getItemsFromState } from "../subscription";

const HeaderContainer = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 100;
`;

const TitleSection = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

const Title = styled.h1`
  font-size: var(--font-size-xl);
  margin: 0;
  color: var(--color-primary);
`;

const Actions = styled.div`
  display: flex;
  gap: var(--space-sm);
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
  const { state } = useAppContext();
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const items = getItemsFromState(state);
  const checkedCount = items.filter((item) => item.checked).length;
  const listName = state.list?.name || "List";

  const handleCopyId = () => {
    navigator.clipboard.writeText(listId);
    message.success("List ID copied!");
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
    signOut(auth);
  };

  return (
    <HeaderContainer>
      <TitleSection>
        <Button icon={<UnorderedListOutlined />} onClick={() => navigate("/")} />
        <Title>{listName}</Title>
      </TitleSection>
      <Actions>
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
      </Actions>

      <Modal
        title={`Share "${listName}"`}
        open={shareModalOpen}
        onCancel={() => setShareModalOpen(false)}
        footer={null}
      >
        <ModalForm>
          <FormField>
            <Label>List ID</Label>
            <Input
              value={listId}
              readOnly
              addonAfter={
                <Button type="text" size="small" onClick={handleCopyId}>
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
