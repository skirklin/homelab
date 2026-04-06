import { useState } from "react";
import { Checkbox, Button, Input } from "antd";
import { DeleteOutlined, HolderOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";
import { useDraggable } from "@dnd-kit/core";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import type { GroceryItem as GroceryItemType } from "../types";
import { toggleItem, deleteItem, updateItem } from "../firestore";

const ItemRow = styled.div<{ $checked: boolean; $isDragging: boolean }>`
  display: flex;
  align-items: center;
  padding: var(--space-xs) var(--space-sm);
  background: ${(props) =>
    props.$isDragging ? "var(--color-primary-light, #e6f7f7)" :
    props.$checked ? "var(--color-bg-muted)" : "var(--color-bg)"};
  border-bottom: 1px solid var(--color-border-light);
  transition: background 0.2s;
  opacity: ${(props) => (props.$isDragging ? 0.8 : 1)};

  &:last-child {
    border-bottom: none;
  }
`;

const DragHandle = styled.span`
  color: var(--color-text-muted);
  margin-right: 2px;
  cursor: grab;
  padding: 2px;
  touch-action: none;
`;

const ItemName = styled.span<{ $checked: boolean }>`
  flex: 1;
  font-size: var(--font-size-sm);
  color: ${(props) =>
    props.$checked ? "var(--color-text-muted)" : "var(--color-text)"};
  text-decoration: ${(props) => (props.$checked ? "line-through" : "none")};
  margin-left: var(--space-xs);
  cursor: pointer;

  &:hover {
    text-decoration: ${(props) => (props.$checked ? "line-through" : "underline")};
  }
`;

const ItemNote = styled.span`
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-left: var(--space-xs);
`;

const DeleteButton = styled(Button)`
  opacity: 0.5;

  &:hover {
    opacity: 1;
  }
`;

const EditContainer = styled.div`
  flex: 1;
  display: flex;
  gap: var(--space-xs);
  margin-left: var(--space-xs);
`;

const IngredientInput = styled(Input)`
  flex: 2;
`;

const NoteInput = styled(Input)`
  flex: 1;
`;

const EditActions = styled.div`
  display: flex;
  gap: 2px;
`;

interface Props {
  item: GroceryItemType;
}

export function GroceryItemRow({ item }: Props) {
  const { user } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [editIngredient, setEditIngredient] = useState(item.ingredient);
  const [editNote, setEditNote] = useState(item.note || "");

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { item },
  });

  const handleToggle = () => {
    if (user) {
      toggleItem(item, user.uid);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteItem(item.id);
  };

  const handleStartEdit = () => {
    setEditIngredient(item.ingredient);
    setEditNote(item.note || "");
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditIngredient(item.ingredient);
    setEditNote(item.note || "");
  };

  const handleSaveEdit = () => {
    const trimmedIngredient = editIngredient.trim();
    if (!trimmedIngredient) {
      handleCancelEdit();
      return;
    }

    const trimmedNote = editNote.trim();

    // Only update if something changed
    if (trimmedIngredient !== item.ingredient || trimmedNote !== (item.note || "")) {
      updateItem(item.id, {
        ingredient: trimmedIngredient,
        note: trimmedNote,
      }).catch((error) => {
        console.error("Failed to update item:", error);
      });
    }

    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveEdit();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  };

  return (
    <ItemRow
      ref={setNodeRef}
      $checked={item.checked}
      $isDragging={isDragging}
    >
      <DragHandle {...attributes} {...listeners} data-testid="drag-handle">
        <HolderOutlined />
      </DragHandle>
      <Checkbox
        checked={item.checked}
        onChange={handleToggle}
      />
      {isEditing ? (
        <>
          <EditContainer>
            <IngredientInput
              size="small"
              value={editIngredient}
              onChange={(e) => setEditIngredient(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder="Ingredient"
            />
            <NoteInput
              size="small"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Note"
            />
          </EditContainer>
          <EditActions>
            <Button
              type="text"
              size="small"
              icon={<CheckOutlined />}
              onClick={handleSaveEdit}
            />
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              onClick={handleCancelEdit}
            />
          </EditActions>
        </>
      ) : (
        <>
          <ItemName $checked={item.checked} onClick={handleStartEdit}>
            {item.ingredient}
            {item.note && <ItemNote>({item.note})</ItemNote>}
          </ItemName>
          <DeleteButton
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={handleDelete}
          />
        </>
      )}
    </ItemRow>
  );
}
