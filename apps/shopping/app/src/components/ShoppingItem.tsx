import { useEffect, useRef, useState } from "react";
import { Checkbox, Button, Input, Drawer } from "antd";
import { DeleteOutlined, CheckOutlined, CloseOutlined, TagOutlined } from "@ant-design/icons";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import type { ShoppingItem, CategoryDef } from "../types";
import { UNCATEGORIZED_CATEGORY_ID } from "../types";
import { useShoppingBackend } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";

const ItemRow = styled.div<{ $checked: boolean }>`
  display: flex;
  align-items: center;
  padding: var(--space-xs) var(--space-sm);
  background: ${(props) =>
    props.$checked ? "var(--color-bg-muted)" : "var(--color-bg)"};
  border-bottom: 1px solid var(--color-border-light);
  transition: background 0.2s;

  &:last-child {
    border-bottom: none;
  }
`;

const SheetList = styled.div`
  display: flex;
  flex-direction: column;
`;

const SheetOption = styled.button<{ $current: boolean }>`
  appearance: none;
  background: ${(p) => (p.$current ? "var(--color-primary-light, #e6f7f7)" : "transparent")};
  border: none;
  border-bottom: 1px solid var(--color-border-light);
  padding: var(--space-md) var(--space-md);
  font-size: var(--font-size-md);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  color: var(--color-text);

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: var(--color-bg-muted);
  }
`;

const SheetCheck = styled.span`
  color: var(--color-primary, #1677ff);
  font-size: 16px;
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

// Shared styling for the right-side row actions (move + delete). Half opacity
// at rest so they recede; full opacity on hover so they feel tappable.
const ActionButton = styled(Button)`
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
  item: ShoppingItem;
}

export function ShoppingItemRow({ item }: Props) {
  const { user } = useAuth();
  const shopping = useShoppingBackend();
  const { state } = useShoppingContext();
  const [isEditing, setIsEditing] = useState(false);
  const [editIngredient, setEditIngredient] = useState(item.ingredient);
  const [editNote, setEditNote] = useState(item.note || "");
  const [categorySheetOpen, setCategorySheetOpen] = useState(false);

  // Long-press wiring for touch devices. Tapping the item name fired edit
  // mode too easily on the phone, especially during scrolling. On touch we
  // now require a ~500ms hold (with a small movement tolerance so a scroll
  // gesture doesn't latch). Mouse/pen keep the instant-click behavior so
  // desktop ergonomics don't regress.
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return () => {
      if (longPressTimer.current !== null) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    };
  }, []);

  // Categories for the bottom sheet. Mirror the construction in
  // ShoppingList.tsx so the "Uncategorized" pseudo-category is always an
  // option even when the list doesn't have it configured.
  const configuredCategories = state.list?.categories || [];
  const hasUncategorized = configuredCategories.some((c) => c.id === UNCATEGORIZED_CATEGORY_ID);
  const uncategorizedDef: CategoryDef = { id: UNCATEGORIZED_CATEGORY_ID, name: "Uncategorized" };
  const sheetCategories = hasUncategorized
    ? configuredCategories
    : [...configuredCategories, uncategorizedDef];

  const currentCategory =
    sheetCategories.find((c) => c.id === item.categoryId) ?? uncategorizedDef;

  const handleSelectCategory = (categoryId: string) => {
    if (categoryId !== item.categoryId) {
      void shopping.updateItemCategory(item.id, categoryId);
    }
    setCategorySheetOpen(false);
  };

  const handleToggle = () => {
    if (user) {
      shopping.toggleItem(item.id, !item.checked, user.uid);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    shopping.deleteItem(item.id);
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

    // Only update if something changed. Errors flow through wpb (transient
    // → queued for retry, permanent → unhandled rejection → global toast)
    // so we don't catch locally.
    if (trimmedIngredient !== item.ingredient || trimmedNote !== (item.note || "")) {
      void shopping.updateItem(item.id, {
        ingredient: trimmedIngredient,
        note: trimmedNote,
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

  const handleNamePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    longPressStart.current = { x: e.clientX, y: e.clientY };
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressStart.current = null;
      handleStartEdit();
    }, 500);
  };

  const handleNamePointerMove = (e: React.PointerEvent) => {
    if (longPressTimer.current === null || !longPressStart.current) return;
    const dx = e.clientX - longPressStart.current.x;
    const dy = e.clientY - longPressStart.current.y;
    if (Math.hypot(dx, dy) > 5) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
      longPressStart.current = null;
    }
  };

  const handleNamePointerEnd = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  };

  const handleNameClick = (e: React.MouseEvent) => {
    // React's MouseEvent doesn't expose pointerType, but the underlying
    // native event on a PointerEvent-emitting browser does. Touch "click"
    // is already handled via the long-press timer in pointerdown, so we
    // suppress the click path for touch and only fire for mouse/pen.
    const native = e.nativeEvent as PointerEvent;
    if (native.pointerType === "touch") return;
    handleStartEdit();
  };

  return (
    <>
    <ItemRow $checked={item.checked}>
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
          <ItemName
            $checked={item.checked}
            onClick={handleNameClick}
            onPointerDown={handleNamePointerDown}
            onPointerMove={handleNamePointerMove}
            onPointerUp={handleNamePointerEnd}
            onPointerCancel={handleNamePointerEnd}
            onPointerLeave={handleNamePointerEnd}
          >
            {item.ingredient}
            {item.note && <ItemNote>({item.note})</ItemNote>}
          </ItemName>
          <ActionButton
            type="text"
            size="small"
            icon={<TagOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              setCategorySheetOpen(true);
            }}
            data-testid="category-move-button"
            title={`Move to category (currently ${currentCategory.name})`}
          />
          <ActionButton
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={handleDelete}
          />
        </>
      )}
    </ItemRow>
    <Drawer
      open={categorySheetOpen}
      onClose={() => setCategorySheetOpen(false)}
      placement="bottom"
      height="auto"
      title={`Move "${item.ingredient}" to…`}
      styles={{ body: { padding: 0 }, header: { padding: "12px 16px" } }}
      data-testid="category-sheet"
    >
      <SheetList>
        {sheetCategories.map((cat) => (
          <SheetOption
            key={cat.id}
            type="button"
            $current={cat.id === item.categoryId}
            onClick={() => handleSelectCategory(cat.id)}
            data-testid={`category-sheet-option-${cat.id}`}
          >
            <span>{cat.name}</span>
            {cat.id === item.categoryId && (
              <SheetCheck>
                <CheckOutlined />
              </SheetCheck>
            )}
          </SheetOption>
        ))}
      </SheetList>
    </Drawer>
    </>
  );
}
