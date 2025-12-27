import { Button } from "antd";
import { LogoutOutlined, CheckOutlined } from "@ant-design/icons";
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

const Title = styled.h1`
  font-size: var(--font-size-xl);
  margin: 0;
  color: var(--color-primary);
`;

const Actions = styled.div`
  display: flex;
  gap: var(--space-sm);
`;

export function Header() {
  const { state } = useAppContext();
  const items = getItemsFromState(state);
  const checkedCount = items.filter((item) => item.checked).length;

  const handleDoneShopping = async () => {
    if (checkedCount === 0) return;

    // Skip confirmation for now - directly clear checked items
    console.log("Done shopping clicked, clearing", checkedCount, "items");
    try {
      await clearCheckedItems(items);
      console.log("Items cleared successfully");
    } catch (error) {
      console.error("Failed to clear items:", error);
    }
  };

  const handleSignOut = () => {
    signOut(auth);
  };

  return (
    <HeaderContainer>
      <Title>Groceries</Title>
      <Actions>
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
    </HeaderContainer>
  );
}
