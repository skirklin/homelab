import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, Modal, message } from "antd";
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ArrowUpOutlined, ArrowDownOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAppContext } from "../context";
import { renameList, renameUserSlug, removeUserSlug, deleteList, updateCategories } from "../firestore";
import type { CategoryDef } from "../types";

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

interface Props {
  slug: string;
  listId: string;
  onBack: () => void;
}

export function ListSettings({ slug, listId, onBack }: Props) {
  const navigate = useNavigate();
  const { state } = useAppContext();
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [slugModalOpen, setSlugModalOpen] = useState(false);
  const [newName, setNewName] = useState(state.list?.name || "");
  const [newSlug, setNewSlug] = useState(slug);
  const [submitting, setSubmitting] = useState(false);

  // Category management
  const [localCategories, setLocalCategories] = useState<CategoryDef[]>(state.list?.categories || []);
  const [newCategory, setNewCategory] = useState("");
  const [editingCategory, setEditingCategory] = useState<CategoryDef | null>(null);
  const [editCategoryName, setEditCategoryName] = useState("");

  const handleAddCategory = () => {
    const trimmed = newCategory.trim();
    if (!trimmed) return;

    // Generate ID from name (lowercase, replace spaces with dashes)
    const id = trimmed.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

    // Check if ID already exists
    if (localCategories.some(c => c.id === id)) {
      message.warning("A category with this name already exists");
      return;
    }

    const newCat: CategoryDef = { id, name: trimmed };
    const updated = [...localCategories, newCat];
    setLocalCategories(updated);
    updateCategories(updated);
    setNewCategory("");
  };

  const handleRemoveCategory = (cat: CategoryDef) => {
    const updated = localCategories.filter((c) => c.id !== cat.id);
    setLocalCategories(updated);
    updateCategories(updated);
  };

  const handleRenameCategory = () => {
    if (!editingCategory || !editCategoryName.trim()) return;

    const updated = localCategories.map(c =>
      c.id === editingCategory.id ? { ...c, name: editCategoryName.trim() } : c
    );
    setLocalCategories(updated);
    updateCategories(updated);
    setEditingCategory(null);
    setEditCategoryName("");
  };

  const handleMoveCategoryUp = (index: number) => {
    if (index === 0) return;
    const updated = [...localCategories];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    setLocalCategories(updated);
    updateCategories(updated);
  };

  const handleMoveCategoryDown = (index: number) => {
    if (index === localCategories.length - 1) return;
    const updated = [...localCategories];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    setLocalCategories(updated);
    updateCategories(updated);
  };

  const handleRename = async () => {
    if (!newName.trim()) return;

    setSubmitting(true);
    try {
      await renameList(listId, newName.trim());
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
    if (!newSlug.trim() || !state.authUser) return;

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
      await renameUserSlug(state.authUser.uid, slug, cleanSlug);
      setSlugModalOpen(false);
      navigate(`/${cleanSlug}`, { replace: true });
      message.success("URL updated");
    } catch (error) {
      console.error("Failed to change slug:", error);
      message.error("Failed to change URL");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveFromMyLists = async () => {
    if (!state.authUser) return;

    Modal.confirm({
      title: "Remove from My Lists?",
      content: "This will remove the list from your account. The list will still exist and others can still access it.",
      okText: "Remove",
      okButtonProps: { danger: true },
      onOk: async () => {
        await removeUserSlug(state.authUser!.uid, slug);
        navigate("/");
        message.success("List removed from your account");
      },
    });
  };

  const handleDeleteList = async () => {
    if (!state.authUser) return;

    Modal.confirm({
      title: "Delete List Forever?",
      content: "This will permanently delete the list and all its items. This cannot be undone.",
      okText: "Delete Forever",
      okButtonProps: { danger: true },
      onOk: async () => {
        await removeUserSlug(state.authUser!.uid, slug);
        await deleteList(listId);
        navigate("/");
        message.success("List deleted");
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
            {localCategories.map((cat, index) => (
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
                  disabled={index === localCategories.length - 1}
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
          placeholder="groceries"
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
