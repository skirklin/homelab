import { Checkbox, Button } from "antd";
import { DeleteOutlined, HolderOutlined } from "@ant-design/icons";
import { useDraggable } from "@dnd-kit/core";
import styled from "styled-components";
import type { GroceryItem as GroceryItemType } from "../types";
import { useAppContext } from "../context";
import { toggleItem, deleteItem } from "../firestore";

const ItemRow = styled.div<{ $checked: boolean; $isDragging: boolean }>`
  display: flex;
  align-items: center;
  padding: var(--space-sm) var(--space-md);
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
  margin-right: var(--space-xs);
  cursor: grab;
  padding: 4px;
  touch-action: none;
`;

const ItemName = styled.span<{ $checked: boolean }>`
  flex: 1;
  font-size: var(--font-size-base);
  color: ${(props) =>
    props.$checked ? "var(--color-text-muted)" : "var(--color-text)"};
  text-decoration: ${(props) => (props.$checked ? "line-through" : "none")};
  margin-left: var(--space-sm);
`;

const DeleteButton = styled(Button)`
  opacity: 0.5;

  &:hover {
    opacity: 1;
  }
`;

interface Props {
  item: GroceryItemType;
}

export function GroceryItemRow({ item }: Props) {
  const { state } = useAppContext();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { item },
  });

  const handleToggle = () => {
    if (state.authUser) {
      toggleItem(item, state.authUser.uid);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteItem(item.id);
  };

  return (
    <ItemRow
      ref={setNodeRef}
      $checked={item.checked}
      $isDragging={isDragging}
    >
      <DragHandle {...attributes} {...listeners}>
        <HolderOutlined />
      </DragHandle>
      <Checkbox
        checked={item.checked}
        onChange={handleToggle}
      />
      <ItemName $checked={item.checked}>{item.name}</ItemName>
      <DeleteButton
        type="text"
        size="small"
        icon={<DeleteOutlined />}
        onClick={handleDelete}
      />
    </ItemRow>
  );
}
