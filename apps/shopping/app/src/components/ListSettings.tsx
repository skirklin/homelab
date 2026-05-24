import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, Modal } from "antd";
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ArrowUpOutlined, ArrowDownOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth, useFeedback } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { useShoppingBackend, useUserBackend } from "@kirkl/shared";
import type { CategoryDef, ItemHistory } from "../types";

const Container = styled.div`
  min-height: 100vh;
  min-height: 100dvh;
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
`;

const Content = styled.main`
  flex: 1;
  padding: var(--space-md);
`;

const Section = styled.div`
  margin-bottom: var(--space-lg);
`;

const SectionTitle = styled.h2`
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0 0 var(--space-sm) 0;
`;

const SettingRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-sm);
`;

const SettingLabel = styled.span`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`;

const SettingValue = styled.span`
  font-weight: 500;
`;

const DangerZone = styled.div`
  margin-top: var(--space-xl);
  padding: var(--space-md);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-md);
`;

const DangerTitle = styled.h3`
  color: var(--color-accent);
  margin: 0 0 var(--space-md) 0;
  font-size: var(--font-size-base);
`;

const DangerButtons = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
`;

const CategoryList = styled.div`
  margin-bottom: var(--space-sm);
`;

const CategoryRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-xs);
`;

const CategoryName = styled.span`
  flex: 1;
  font-size: var(--font-size-base);
  text-transform: capitalize;
`;

const AddCategoryRow = styled.div`
  display: flex;
  gap: var(--space-sm);
`;

const SuggestionRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  margin-bottom: var(--space-xs);
`;

const SuggestionName = styled.span`
  flex: 1;
  font-size: var(--font-size-base);
`;

const SuggestionMeta = styled.span`
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
`;

const SuggestionEmpty = styled.div`
  padding: var(--space-md);
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
`;

interface Props {
  slug: string;
  listId: string;
  onBack: () => void;
}

export function ListSettings({ slug, listId, onBack }: Props) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { state } = useShoppingContext();
  const { modal, message } = useFeedback();
  const shopping = useShoppingBackend();
  const userBackend = useUserBackend();

  // Handle Escape key to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack]);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [slugModalOpen, setSlugModalOpen] = useState(false);
  const [newName, setNewName] = useState(state.list?.name || "");
  const [newSlug, setNewSlug] = useState(slug);
  const [submitting, setSubmitting] = useState(false);

  // Category management — derived from state, not shadowed in local state.
  // The optimistic write settles via the wpb subscription, so any local
  // shadow inevitably drifts when a peer (or our own retry) reconciles a
  // different shape. Last-write-wins on `state.list.categories` keeps the UI
  // and the backend in lockstep without a second source of truth.
  const categories = useMemo(
    () => state.list?.categories || [],
    [state.list?.categories],
  );
  const [newCategory, setNewCategory] = useState("");
  const [editingCategory, setEditingCategory] = useState<CategoryDef | null>(null);
  const [editCategoryName, setEditCategoryName] = useState("");

  const handleAddCategory = () => {
    const trimmed = newCategory.trim();
    if (!trimmed) return;

    // Generate ID from name (lowercase, replace spaces with dashes)
    const id = trimmed.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

    // Check if ID already exists
    if (categories.some(c => c.id === id)) {
      message.warning("A category with this name already exists");
      return;
    }

    const newCat: CategoryDef = { id, name: trimmed };
    shopping.updateCategories(listId, [...categories, newCat]);
    setNewCategory("");
  };

  const handleRemoveCategory = (cat: CategoryDef) => {
    shopping.updateCategories(listId, categories.filter((c) => c.id !== cat.id));
  };

  const handleRenameCategory = () => {
    if (!editingCategory || !editCategoryName.trim()) return;

    const updated = categories.map(c =>
      c.id === editingCategory.id ? { ...c, name: editCategoryName.trim() } : c
    );
    shopping.updateCategories(listId, updated);
    setEditingCategory(null);
    setEditCategoryName("");
  };

  const handleMoveCategoryUp = (index: number) => {
    if (index === 0) return;
    const updated = [...categories];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    shopping.updateCategories(listId, updated);
  };

  const handleMoveCategoryDown = (index: number) => {
    if (index === categories.length - 1) return;
    const updated = [...categories];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    shopping.updateCategories(listId, updated);
  };

  const handleRename = async () => {
    if (!newName.trim()) return;

    setSubmitting(true);
    try {
      await shopping.renameList(listId, newName.trim());
      setRenameModalOpen(false);
      message.success("List renamed");
    } catch (error) {
      console.error("Failed to rename list:", error);
      message.error("Failed to rename list");
    } finally {
      setSubmitting(false);
    }
  };

  const handleChangeSlug = async () => {
    if (!newSlug.trim() || !user) return;

    const cleanSlug = newSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");

    if (cleanSlug === slug) {
      setSlugModalOpen(false);
      return;
    }

    if (state.userSlugs[cleanSlug]) {
      message.error(`You already have a list with the slug "/${cleanSlug}"`);
      return;
    }

    setSubmitting(true);
    try {
      await userBackend.renameSlug(user.uid, "shopping", slug, cleanSlug);
      setSlugModalOpen(false);
      navigate(cleanSlug, { replace: true });
      message.success("URL updated");
    } catch (error) {
      console.error("Failed to change slug:", error);
      message.error("Failed to change URL");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveFromMyLists = async () => {
    if (!user) return;

    modal.confirm({
      title: "Remove from My Lists?",
      content: "This will remove the list from your account. The list will still exist and others can still access it.",
      okText: "Remove",
      okButtonProps: { danger: true },
      onOk: async () => {
        await userBackend.removeSlug(user!.uid, "shopping", slug);
        navigate("..");
        message.success("List removed from your account");
      },
    });
  };

  const handleDeleteList = async () => {
    if (!user) return;

    modal.confirm({
      title: "Delete List Forever?",
      content: "This will permanently delete the list and all its items. This cannot be undone.",
      okText: "Delete Forever",
      okButtonProps: { danger: true },
      onOk: async () => {
        await userBackend.removeSlug(user!.uid, "shopping", slug);
        await shopping.deleteList(listId);
        navigate("..");
        message.success("List deleted");
      },
    });
  };

  // --- Manage suggestions ---

  const [suggestionFilter, setSuggestionFilter] = useState("");
  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [editSuggestionValue, setEditSuggestionValue] = useState("");

  const sortedSuggestions = useMemo(() => {
    const normFilter = suggestionFilter.trim().toLowerCase();
    const rows: ItemHistory[] = state.history.slice();
    rows.sort((a, b) => a.ingredient.localeCompare(b.ingredient));
    if (!normFilter) return rows;
    return rows.filter((r) => r.ingredient.toLowerCase().includes(normFilter));
  }, [state.history, suggestionFilter]);

  const categoryNameLookup = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories) m.set(c.id, c.name);
    return m;
  }, [categories]);

  const formatRelative = (d: Date) => {
    const ms = Date.now() - d.getTime();
    if (Number.isNaN(ms)) return "—";
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d2 = Math.floor(h / 24);
    if (d2 < 30) return `${d2}d ago`;
    const mo = Math.floor(d2 / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
  };

  const startEditSuggestion = (h: ItemHistory) => {
    setEditingSuggestionId(h.id);
    setEditSuggestionValue(h.ingredient);
  };

  const cancelEditSuggestion = () => {
    setEditingSuggestionId(null);
    setEditSuggestionValue("");
  };

  const performRename = async (id: string, newIngredient: string) => {
    try {
      await shopping.renameHistoryEntry(id, newIngredient);
      cancelEditSuggestion();
      message.success("Suggestion renamed");
    } catch (err) {
      console.error("Failed to rename suggestion:", err);
      message.error("Failed to rename suggestion");
    }
  };

  const handleSaveSuggestionEdit = (h: ItemHistory) => {
    const next = editSuggestionValue.trim();
    if (!next) {
      message.warning("Name cannot be empty");
      return;
    }
    const normalized = next.toLowerCase();
    if (normalized === h.ingredient.toLowerCase()) {
      cancelEditSuggestion();
      return;
    }

    // Detect a normalized-name collision client-side so we can show a clear
    // merge confirmation. The backend will dedupe regardless, but asking
    // first makes the data loss explicit.
    const collision = state.history.find(
      (other) => other.id !== h.id && other.ingredient.toLowerCase() === normalized,
    );

    if (collision) {
      modal.confirm({
        title: `Merge into existing "${collision.ingredient}"?`,
        content: `This will delete "${h.ingredient}" and combine usage into "${collision.ingredient}".`,
        okText: "Merge",
        okButtonProps: { danger: true },
        onOk: () => performRename(h.id, next),
      });
      return;
    }

    void performRename(h.id, next);
  };

  const handleDeleteSuggestion = (h: ItemHistory) => {
    modal.confirm({
      title: `Delete suggestion "${h.ingredient}"?`,
      content: "This won't affect items already on your list — only future autocomplete.",
      okText: "Delete",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await shopping.deleteHistoryEntry(h.id);
          message.success("Suggestion deleted");
        } catch (err) {
          console.error("Failed to delete suggestion:", err);
          message.error("Failed to delete suggestion");
        }
      },
    });
  };

  return (
    <Container>
      <Header>
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={onBack}
          style={{ color: "white" }}
        />
        <Title>List Settings</Title>
      </Header>
      <Content>
        <Section>
          <SectionTitle>List Name</SectionTitle>
          <SettingRow>
            <div>
              <SettingValue>{state.list?.name || "Untitled"}</SettingValue>
              <br />
              <SettingLabel>Visible to everyone with access</SettingLabel>
            </div>
            <Button icon={<EditOutlined />} onClick={() => {
              setNewName(state.list?.name || "");
              setRenameModalOpen(true);
            }}>
              Rename
            </Button>
          </SettingRow>
        </Section>

        <Section>
          <SectionTitle>Your URL</SectionTitle>
          <SettingRow>
            <div>
              <SettingValue>/{slug}</SettingValue>
              <br />
              <SettingLabel>Only you see this URL</SettingLabel>
            </div>
            <Button icon={<EditOutlined />} onClick={() => {
              setNewSlug(slug);
              setSlugModalOpen(true);
            }}>
              Change
            </Button>
          </SettingRow>
        </Section>

        <Section>
          <SectionTitle>Categories</SectionTitle>
          <CategoryList>
            {categories.map((cat, index) => (
              <CategoryRow key={cat.id}>
                <CategoryName>{cat.name}</CategoryName>
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditingCategory(cat);
                    setEditCategoryName(cat.name);
                  }}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowUpOutlined />}
                  onClick={() => handleMoveCategoryUp(index)}
                  disabled={index === 0}
                />
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowDownOutlined />}
                  onClick={() => handleMoveCategoryDown(index)}
                  disabled={index === categories.length - 1}
                />
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleRemoveCategory(cat)}
                />
              </CategoryRow>
            ))}
          </CategoryList>
          <AddCategoryRow>
            <Input
              placeholder="New category..."
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              onPressEnter={handleAddCategory}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleAddCategory}
              disabled={!newCategory.trim()}
            >
              Add
            </Button>
          </AddCategoryRow>
        </Section>

        <Section>
          <SectionTitle>Manage suggestions</SectionTitle>
          <SettingLabel>
            Edits affect autocomplete only — items already on your list and past trips are untouched.
          </SettingLabel>
          <div style={{ height: "var(--space-sm)" }} />
          <Input
            placeholder="Filter suggestions..."
            value={suggestionFilter}
            onChange={(e) => setSuggestionFilter(e.target.value)}
            allowClear
            style={{ marginBottom: "var(--space-sm)" }}
          />
          {sortedSuggestions.length === 0 ? (
            <SuggestionEmpty>
              {state.history.length === 0
                ? "No suggestions yet — add some items to populate history."
                : "No matches for that filter."}
            </SuggestionEmpty>
          ) : (
            sortedSuggestions.map((h) => {
              const isEditing = editingSuggestionId === h.id;
              return (
                <SuggestionRow key={h.id}>
                  {isEditing ? (
                    <>
                      <Input
                        value={editSuggestionValue}
                        onChange={(e) => setEditSuggestionValue(e.target.value)}
                        onPressEnter={() => handleSaveSuggestionEdit(h)}
                        autoFocus
                        size="small"
                        style={{ flex: 1 }}
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<CheckOutlined />}
                        onClick={() => handleSaveSuggestionEdit(h)}
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<CloseOutlined />}
                        onClick={cancelEditSuggestion}
                      />
                    </>
                  ) : (
                    <>
                      <SuggestionName>{h.ingredient}</SuggestionName>
                      <SuggestionMeta>
                        {categoryNameLookup.get(h.categoryId) || h.categoryId}
                      </SuggestionMeta>
                      <SuggestionMeta>{formatRelative(h.lastAdded)}</SuggestionMeta>
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => startEditSuggestion(h)}
                      />
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => handleDeleteSuggestion(h)}
                      />
                    </>
                  )}
                </SuggestionRow>
              );
            })
          )}
        </Section>

        <DangerZone>
          <DangerTitle>Danger Zone</DangerTitle>
          <DangerButtons>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleRemoveFromMyLists}
            >
              Remove from My Lists
            </Button>
            <Button
              danger
              type="primary"
              icon={<DeleteOutlined />}
              onClick={handleDeleteList}
            >
              Delete List Forever
            </Button>
          </DangerButtons>
        </DangerZone>
      </Content>

      {/* Rename Modal */}
      <Modal
        title="Rename List"
        open={renameModalOpen}
        onOk={handleRename}
        onCancel={() => setRenameModalOpen(false)}
        confirmLoading={submitting}
        okText="Rename"
        okButtonProps={{ disabled: !newName.trim() }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="List name"
          onPressEnter={handleRename}
        />
      </Modal>

      {/* Change Slug Modal */}
      <Modal
        title="Change Your URL"
        open={slugModalOpen}
        onOk={handleChangeSlug}
        onCancel={() => setSlugModalOpen(false)}
        confirmLoading={submitting}
        okText="Change"
        okButtonProps={{ disabled: !newSlug.trim() }}
      >
        <Input
          value={newSlug}
          onChange={(e) => setNewSlug(e.target.value)}
          placeholder="shopping"
          addonBefore="/"
          onPressEnter={handleChangeSlug}
        />
      </Modal>

      {/* Rename Category Modal */}
      <Modal
        title="Rename Category"
        open={editingCategory !== null}
        onOk={handleRenameCategory}
        onCancel={() => {
          setEditingCategory(null);
          setEditCategoryName("");
        }}
        okText="Rename"
        okButtonProps={{ disabled: !editCategoryName.trim() }}
      >
        <Input
          value={editCategoryName}
          onChange={(e) => setEditCategoryName(e.target.value)}
          placeholder="Category name"
          onPressEnter={handleRenameCategory}
        />
      </Modal>
    </Container>
  );
}
