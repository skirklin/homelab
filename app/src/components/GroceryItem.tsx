import { Checkbox, Button } from "antd";
import { DeleteOutlined } from "@ant-design/icons";
import styled from "styled-components";
import type { GroceryItem as GroceryItemType } from "../types";
import { useAppContext } from "../context";
import { toggleItem, deleteItem } from "../firestore";

const ItemRow = styled.div<{ $checked: boolean }>`
  display: flex;
  align-items: center;
  padding: var(--space-sm) var(--space-md);
  background: ${(props) =>
    props.$checked ? "var(--color-bg-muted)" : "var(--color-bg)"};
  border-bottom: 1px solid var(--color-border-light);
  transition: background 0.2s;

  &:last-child {
    border-bottom: none;
  }
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
    <ItemRow $checked={item.checked} onClick={handleToggle}>
      <Checkbox checked={item.checked} />
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
