/**
 * Shared list management components for apps with multi-list support.
 * Used by shopping and upkeep apps.
 */

import { useState, useEffect, type ReactNode } from "react";
import { useNavigate, useSearchParams, useParams } from "react-router-dom";
import { Button, Input, List, Modal, Spin, message } from "antd";
import { PlusOutlined, LinkOutlined, RightOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth } from "./auth";
import type { AppStorage } from "./appStorage";

// Styled components
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

const ErrorBox = styled.div`
  background: #fff2f0;
  border: 1px solid #ffccc7;
  border-radius: var(--radius-md);
  padding: var(--space-md);
  color: #cf1322;
  text-align: left;
  width: 100%;
  max-width: 400px;
  word-break: break-word;
`;

const JoinContent = styled.main`
  flex: 1;
  padding: var(--space-xl);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-lg);
`;

const JoinListName = styled.h2`
  font-size: var(--font-size-xl);
  margin: 0;
`;

const Description = styled.p`
  color: var(--color-text-secondary);
  margin: 0;
`;

const JoinForm = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  width: 100%;
  max-width: 300px;
`;

const JoinLabel = styled.label`
  font-weight: 500;
  color: var(--color-text-secondary);
  text-align: left;
`;

// ===== Types =====

interface ListInfo {
  slug: string;
  listId: string;
  name: string | null;
}

export interface ListPickerConfig {
  /** Title shown in the header (e.g., "My Lists", "Upkeep") */
  title: string;
  /** Label for new list button (e.g., "New List", "New Task List") */
  newListLabel: string;
  /** Placeholder for new list name input */
  newListPlaceholder: string;
  /** Modal title for creating new list */
  createModalTitle: string;
  /** Empty state message lines */
  emptyMessage: [string, string];
  /** Storage key for remembering last list */
  lastListKey: string;
}

export interface ListOperations {
  /** Get user's slug mapping */
  getUserSlugs: () => Record<string, string>;
  /** Create a new list */
  createList: (name: string, slug: string, userId: string) => Promise<string>;
  /** Set a user's slug to a list ID */
  setUserSlug: (userId: string, slug: string, listId: string) => Promise<void>;
  /** Get list by ID (returns name or null if not found) */
  getListById: (listId: string) => Promise<{ name: string } | null>;
  /** PocketBase collection name for this list type (e.g. "shopping_lists") */
  collection: string;
}

export interface ListPickerProps {
  config: ListPickerConfig;
  operations: ListOperations;
  storage: AppStorage;
  /** Optional additional header content */
  headerContent?: ReactNode;
}

// ===== ListPicker Component =====

export function ListPicker({ config, operations, storage, headerContent }: ListPickerProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [lists, setLists] = useState<ListInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [sharedListId, setSharedListId] = useState("");
  const [sharedListSlug, setSharedListSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const userSlugs = operations.getUserSlugs();

  // Auto-navigate to last-used list only if one is saved
  // Skip if ?pick=true is in URL (user explicitly wants to see the list picker)
  useEffect(() => {
    const wantsPicker = searchParams.get("pick") === "true";
    if (wantsPicker) return;

    const slugs = Object.keys(userSlugs);
    const lastUsed = storage.get<string | null>(config.lastListKey, null);

    // Only auto-navigate if we have a saved last-used list that still exists
    if (lastUsed && slugs.includes(lastUsed)) {
      navigate(lastUsed, { replace: true });
    }
  }, [userSlugs, navigate, searchParams, storage, config.lastListKey]);

  // Load list names for each slug
  useEffect(() => {
    async function loadListNames() {
      const slugEntries = Object.entries(userSlugs);
      const listInfos: ListInfo[] = slugEntries.map(([slug, listId]) => ({
        slug,
        listId,
        name: null,
      }));
      setLists(listInfos);
      setLoading(false);

      // Load names in parallel
      const namesPromises = slugEntries.map(async ([slug, listId]) => {
        const listData = await operations.getListById(listId);
        return { slug, name: listData?.name || "(deleted)" };
      });

      const names = await Promise.all(namesPromises);
      setLists(prev => prev.map(item => {
        const found = names.find(n => n.slug === item.slug);
        return found ? { ...item, name: found.name } : item;
      }));
    }

    loadListNames();
  }, [userSlugs, operations]);

  const handleCreateList = async () => {
    if (!newName.trim() || !user) return;

    const name = newName.trim();
    const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");

    // Validate that the slug is not empty and contains at least one alphanumeric
    if (!slug || !/[a-z0-9]/.test(slug)) {
      message.error("List name must contain at least one letter or number");
      return;
    }

    // Check if slug already exists
    if (userSlugs[slug]) {
      message.error(`You already have a list called "${slug}"`);
      return;
    }

    setSubmitting(true);
    try {
      await operations.createList(name, slug, user.uid);
      setCreateModalOpen(false);
      setNewName("");
      navigate(slug);
    } catch (error) {
      console.error("Failed to create list:", error);
      message.error("Failed to create list");
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddSharedList = async () => {
    if (!sharedListSlug.trim() || !sharedListId.trim() || !user) return;

    const slug = sharedListSlug.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");

    // Validate that the slug is not empty and contains at least one alphanumeric
    if (!slug || !/[a-z0-9]/.test(slug)) {
      message.error("Slug must contain at least one letter or number");
      return;
    }

    // Check if slug already exists
    if (userSlugs[slug]) {
      message.error(`You already have a list called "${slug}"`);
      return;
    }

    setSubmitting(true);
    try {
      // Verify the list exists and add user to owners (server-side)
      const { getListInfo, joinList: joinListApi } = await import("./api");
      const listData = await getListInfo(operations.collection, sharedListId.trim());
      if (!listData) {
        message.error("List not found. Check the ID and try again.");
        setSubmitting(false);
        return;
      }
      await joinListApi(operations.collection, sharedListId.trim());
      await operations.setUserSlug(user.uid, slug, sharedListId.trim());
      setAddModalOpen(false);
      setSharedListSlug("");
      setSharedListId("");
      navigate(slug);
    } catch (error) {
      console.error("Failed to add shared list:", error);
      message.error("Failed to add shared list");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectList = (slug: string) => {
    navigate(slug);
  };

  return (
    <Container>
      <Header>
        <Title>{config.title}</Title>
        {headerContent}
      </Header>
      <Content>
        <Actions>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateModalOpen(true)}
          >
            {config.newListLabel}
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
            <p>{config.emptyMessage[0]}</p>
            <p>{config.emptyMessage[1]}</p>
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
        title={config.createModalTitle}
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
          placeholder={config.newListPlaceholder}
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
              placeholder={config.newListPlaceholder.toLowerCase()}
            />
          </FormField>
        </ModalForm>
      </Modal>
    </Container>
  );
}

// ===== JoinList Component =====

export interface JoinListConfig {
  /** Title shown in the header (e.g., "Join List", "Join Task List") */
  title: string;
  /** Title shown when list cannot be joined */
  errorTitle: string;
  /** Placeholder for slug input */
  slugPlaceholder: string;
}

export interface JoinListProps {
  config: JoinListConfig;
  operations: ListOperations;
}

export function JoinList({ config, operations }: JoinListProps) {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [listName, setListName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const userSlugs = operations.getUserSlugs();

  useEffect(() => {
    async function loadList() {
      if (!listId) {
        setError("No list ID provided");
        setLoading(false);
        return;
      }

      // Auth is still loading
      if (user === undefined) return;

      // User is not authenticated
      if (!user) {
        setError("You must be signed in to join a list");
        setLoading(false);
        return;
      }

      try {
        const list = await operations.getListById(listId);
        if (list) {
          setListName(list.name);
          // Suggest a slug based on the list name
          const suggested = list.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          setSlug(suggested);
        } else {
          setError("List not found. It may have been deleted.");
        }
      } catch (err) {
        console.error("[JoinList] Error loading list:", err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes("permission") || errorMessage.includes("Permission")) {
          setError(`Permission denied. Please make sure you're signed in. (${errorMessage})`);
        } else {
          setError(`Failed to load list: ${errorMessage}`);
        }
      } finally {
        setLoading(false);
      }
    }
    loadList();
  }, [listId, user, operations]);

  const handleJoin = async () => {
    if (!slug.trim() || !listId || !user) return;

    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");

    // Validate that the cleaned slug is not empty and contains at least one alphanumeric
    if (!cleanSlug || !/[a-z0-9]/.test(cleanSlug)) {
      message.error("Slug must contain at least one letter or number");
      return;
    }

    if (userSlugs[cleanSlug]) {
      message.error(`You already have a list at "/${cleanSlug}"`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Add user to the list's owners (server-side, bypasses API rules)
      const { joinList: joinListApi } = await import("./api");
      await joinListApi(operations.collection, listId);
      // Save the user's slug mapping
      await operations.setUserSlug(user.uid, cleanSlug, listId);
      navigate("/" + cleanSlug);
    } catch (err) {
      console.error("[JoinList] Failed to join list:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to join list: ${errorMessage}`);
      message.error("Failed to join list - see error below");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Container>
        <Header>
          <Title>{config.title}</Title>
        </Header>
        <JoinContent>
          <Spin size="large" />
          <Description>Loading list...</Description>
        </JoinContent>
      </Container>
    );
  }

  if (error && !listName) {
    return (
      <Container>
        <Header>
          <Title>{config.errorTitle}</Title>
        </Header>
        <JoinContent>
          <ErrorBox>{error}</ErrorBox>
          <Description style={{ fontSize: "12px", marginTop: "8px" }}>
            List ID: {listId || "none"}
          </Description>
          <Button type="primary" onClick={() => navigate("..")}>
            Go to My Lists
          </Button>
        </JoinContent>
      </Container>
    );
  }

  return (
    <Container>
      <Header>
        <Title>{config.title}</Title>
      </Header>
      <JoinContent>
        <JoinListName>{listName}</JoinListName>
        <Description>Choose a URL for this list</Description>
        {error && <ErrorBox>{error}</ErrorBox>}
        <JoinForm>
          <JoinLabel>Your URL</JoinLabel>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={config.slugPlaceholder}
            addonBefore="/"
            onPressEnter={handleJoin}
          />
          <Button
            type="primary"
            size="large"
            onClick={handleJoin}
            loading={submitting}
            disabled={!slug.trim()}
          >
            Add to My Lists
          </Button>
          <Button onClick={() => navigate("..")}>
            Cancel
          </Button>
        </JoinForm>
      </JoinContent>
    </Container>
  );
}
