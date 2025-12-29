import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, List } from "antd";
import { PlusOutlined, UnorderedListOutlined, ArrowLeftOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAppContext } from "../context";
import { createList } from "../firestore";
import { loadUserLists } from "../subscription";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const Header = styled.header`
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--color-primary);
  color: white;
`;

const Title = styled.h1`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  flex: 1;
`;

const Content = styled.main`
  flex: 1;
  padding: var(--space-md);
`;

const CreateForm = styled.div`
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-lg);
`;

const ListItem = styled(List.Item)`
  cursor: pointer;
  padding: var(--space-md) !important;

  &:hover {
    background: var(--color-bg-muted);
  }
`;

const ListIcon = styled(UnorderedListOutlined)`
  font-size: 20px;
  color: var(--color-primary);
  margin-right: var(--space-md);
`;

const EmptyState = styled.div`
  text-align: center;
  padding: var(--space-2xl);
  color: var(--color-text-secondary);
`;

interface Props {
  onBack?: () => void;
}

export function ListPicker({ onBack }: Props) {
  const { state, dispatch } = useAppContext();
  const navigate = useNavigate();
  const [newListName, setNewListName] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreateList = async () => {
    if (!newListName.trim() || !state.authUser) return;

    setCreating(true);
    try {
      const listId = await createList(newListName.trim(), state.authUser.uid);
      setNewListName("");
      // Reload user lists
      await loadUserLists(state.authUser.uid, dispatch);
      // Navigate to the new list
      navigate(`/${listId}`);
    } catch (error) {
      console.error("Failed to create list:", error);
    } finally {
      setCreating(false);
    }
  };

  const handleSelectList = (listId: string) => {
    navigate(`/${listId}`);
  };

  return (
    <Container>
      <Header>
        {onBack && (
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={onBack}
            style={{ color: "white" }}
          />
        )}
        <Title>My Lists</Title>
      </Header>
      <Content>
        <CreateForm>
          <Input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="New list name..."
            size="large"
            onPressEnter={handleCreateList}
          />
          <Button
            type="primary"
            size="large"
            icon={<PlusOutlined />}
            onClick={handleCreateList}
            loading={creating}
            disabled={!newListName.trim()}
          >
            Create
          </Button>
        </CreateForm>

        {state.userLists.length === 0 ? (
          <EmptyState>
            <p>No lists yet.</p>
            <p>Create a new list to get started!</p>
          </EmptyState>
        ) : (
          <List
            bordered
            dataSource={state.userLists}
            renderItem={(list) => (
              <ListItem onClick={() => handleSelectList(list.id)}>
                <ListIcon />
                {list.name}
              </ListItem>
            )}
          />
        )}
      </Content>
    </Container>
  );
}
