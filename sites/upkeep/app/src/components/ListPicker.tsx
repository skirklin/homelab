import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, List, Modal, Spin } from "antd";
import { PlusOutlined, LinkOutlined, RightOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAppContext } from "../context";
import { createList, setUserSlug, getListById } from "../firestore";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const Header = styled.header`
  padding: var(--space-md);
  background: var(--color-primary);
  color: white;
`;

const Title = styled.h1`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
`;

const Content = styled.main`
  flex: 1;
  padding: var(--space-md);
  max-width: 600px;
  margin: 0 auto;
  width: 100%;
`;

const Actions = styled.div`
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-lg);
`;

const ListItemRow = styled(List.Item)`
  cursor: pointer;
  padding: var(--space-md) !important;

  &:hover {
    background: var(--color-bg-muted);
  }
`;

const ListItemContent = styled.div`
  display: flex;
  align-items: center;
  width: 100%;
`;

const ListName = styled.span`
  font-weight: 500;
  flex: 1;
`;

const GoIcon = styled(RightOutlined)`
  color: var(--color-text-muted);
`;

const EmptyState = styled.div`
  text-align: center;
  padding: var(--space-2xl);
  color: var(--color-text-secondary);
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

interface ListInfo {
  slug: string;
  listId: string;
  name: string | null;  // null while loading
}

export function ListPicker() {
  const { state } = useAppContext();
  const navigate = useNavigate();
  const [lists, setLists] = useState<ListInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [sharedListId, setSharedListId] = useState("");
  const [sharedListSlug, setSharedListSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Auto-navigate to last-used list (or first list if none)
  useEffect(() => {
    const slugs = Object.keys(state.userSlugs);
    if (slugs.length > 0) {
      const lastUsed = localStorage.getItem("upkeep-last-list");
      const targetSlug = lastUsed && slugs.includes(lastUsed) ? lastUsed : slugs[0];
      navigate(`/${targetSlug}`, { replace: true });
    }
  }, [state.userSlugs, navigate]);

  // Load list names for each slug
  useEffect(() => {
    async function loadListNames() {
      const slugEntries = Object.entries(state.userSlugs);
      const listInfos: ListInfo[] = slugEntries.map(([slug, listId]) => ({
        slug,
        listId,
        name: null,
      }));
      setLists(listInfos);
      setLoading(false);

      // Load names in parallel
      const namesPromises = slugEntries.map(async ([slug, listId]) => {
        const listData = await getListById(listId);
        return { slug, name: listData?.name || "(deleted)" };
      });

      const names = await Promise.all(namesPromises);
      setLists(prev => prev.map(item => {
        const found = names.find(n => n.slug === item.slug);
        return found ? { ...item, name: found.name } : item;
      }));
    }

    loadListNames();
  }, [state.userSlugs]);

  const handleCreateList = async () => {
    if (!newName.trim() || !state.authUser) return;

    const name = newName.trim();
    const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

    // Check if slug already exists
    if (state.userSlugs[slug]) {
      alert(`You already have a list called "${slug}"`);
      return;
    }

    setSubmitting(true);
    try {
      await createList(name, slug, state.authUser.uid);
      setCreateModalOpen(false);
      setNewName("");
      navigate(`/${slug}`);
    } catch (error) {
      console.error("Failed to create list:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddSharedList = async () => {
    if (!sharedListSlug.trim() || !sharedListId.trim() || !state.authUser) return;

    const slug = sharedListSlug.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

    // Check if slug already exists
    if (state.userSlugs[slug]) {
      alert(`You already have a list called "${slug}"`);
      return;
    }

    setSubmitting(true);
    try {
      // Verify the list exists
      const listData = await getListById(sharedListId.trim());
      if (!listData) {
        alert("List not found. Check the ID and try again.");
        setSubmitting(false);
        return;
      }

      await setUserSlug(state.authUser.uid, slug, sharedListId.trim());
      setAddModalOpen(false);
      setSharedListSlug("");
      setSharedListId("");
      navigate(`/${slug}`);
    } catch (error) {
      console.error("Failed to add shared list:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectList = (slug: string) => {
    navigate(`/${slug}`);
  };

  return (
    <Container>
      <Header>
        <Title>Upkeep</Title>
      </Header>
      <Content>
        <Actions>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateModalOpen(true)}
          >
            New Task List
          </Button>
          <Button
            icon={<LinkOutlined />}
            onClick={() => setAddModalOpen(true)}
          >
            Add Shared List
          </Button>
        </Actions>

        {loading ? (
          <EmptyState><Spin /></EmptyState>
        ) : lists.length === 0 ? (
          <EmptyState>
            <p>No task lists yet.</p>
            <p>Create a new list to start tracking your household tasks!</p>
          </EmptyState>
        ) : (
          <List
            bordered
            dataSource={lists}
            renderItem={(item) => (
              <ListItemRow onClick={() => handleSelectList(item.slug)}>
                <ListItemContent>
                  <ListName>{item.name ?? "..."}</ListName>
                  <GoIcon />
                </ListItemContent>
              </ListItemRow>
            )}
          />
        )}
      </Content>

      {/* Create New List Modal */}
      <Modal
        title="Create New Task List"
        open={createModalOpen}
        onOk={handleCreateList}
        onCancel={() => {
          setCreateModalOpen(false);
          setNewName("");
        }}
        confirmLoading={submitting}
        okText="Create"
        okButtonProps={{ disabled: !newName.trim() }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Home Maintenance"
          onPressEnter={handleCreateList}
          autoFocus
        />
      </Modal>

      {/* Add Shared List Modal */}
      <Modal
        title="Add Shared List"
        open={addModalOpen}
        onOk={handleAddSharedList}
        onCancel={() => {
          setAddModalOpen(false);
          setSharedListSlug("");
          setSharedListId("");
        }}
        confirmLoading={submitting}
        okText="Add"
        okButtonProps={{ disabled: !sharedListSlug.trim() || !sharedListId.trim() }}
      >
        <ModalForm>
          <FormField>
            <Label>List ID (from the person sharing)</Label>
            <Input
              value={sharedListId}
              onChange={(e) => setSharedListId(e.target.value)}
              placeholder="abc123xyz"
            />
          </FormField>
          <FormField>
            <Label>Name for this list</Label>
            <Input
              value={sharedListSlug}
              onChange={(e) => setSharedListSlug(e.target.value)}
              placeholder="home"
            />
          </FormField>
        </ModalForm>
      </Modal>
    </Container>
  );
}
