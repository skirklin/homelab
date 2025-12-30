import { useDroppable } from "@dnd-kit/core";
import styled from "styled-components";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import type { GroceryItem, CategoryDef } from "../types";
import { GroceryItemRow } from "./GroceryItem";

const Section = styled.div<{ $isEmpty: boolean }>`
  margin-bottom: ${(props) => (props.$isEmpty ? "2px" : "var(--space-md)")};
`;

const CategoryHeader = styled.div<{ $isOver: boolean; $isEmpty: boolean; $clickable: boolean }>`
  display: flex;
  align-items: center;
  padding: ${(props) => (props.$isEmpty ? "4px var(--space-md)" : "var(--space-sm) var(--space-md)")};
  background: ${(props) =>
    props.$isOver ? "var(--color-primary-light, #b8e6e6)" : "var(--color-bg-muted)"};
  font-weight: 600;
  font-size: ${(props) => (props.$isEmpty ? "var(--font-size-xs, 11px)" : "var(--font-size-sm)")};
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  transition: background 0.2s;
  opacity: ${(props) => (props.$isEmpty ? 0.6 : 1)};
  cursor: ${(props) => (props.$clickable ? "pointer" : "default")};
  user-select: none;
`;

const CollapseIcon = styled.span`
  margin-right: var(--space-xs);
  font-size: 10px;
  display: flex;
  align-items: center;
`;

const ItemCount = styled.span`
  margin-left: var(--space-sm);
  font-weight: 400;
  color: var(--color-text-muted);
`;

const ItemsContainer = styled.div<{ $isOver: boolean }>`
  background: ${(props) =>
    props.$isOver ? "var(--color-primary-light, #e6f7f7)" : "var(--color-bg)"};
  transition: background 0.2s;
`;

interface Props {
  category: CategoryDef;
  items: GroceryItem[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  forceCollapse?: boolean; // During drag, collapse all
}

export function CategorySection({ category, items, collapsed, onToggleCollapse, forceCollapse }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: category.id,
    data: { categoryId: category.id },
  });

  const isEmpty = items.length === 0;
  const isCollapsed = forceCollapse || collapsed;

  // Sort items by added time only (keep position stable when checking)
  const sortedItems = [...items].sort((a, b) => {
    return a.addedAt.getTime() - b.addedAt.getTime();
  });

  return (
    <Section ref={setNodeRef} $isEmpty={isEmpty}>
      <CategoryHeader
        $isOver={isOver}
        $isEmpty={isEmpty}
        $clickable={!isEmpty}
        onClick={() => !isEmpty && onToggleCollapse()}
      >
        {!isEmpty && (
          <CollapseIcon>
            {isCollapsed ? <RightOutlined /> : <DownOutlined />}
          </CollapseIcon>
        )}
        {category.name}
        {!isEmpty && <ItemCount>({items.length})</ItemCount>}
      </CategoryHeader>
      {!isEmpty && !isCollapsed && (
        <ItemsContainer $isOver={isOver}>
          {sortedItems.map((item) => (
            <GroceryItemRow key={item.id} item={item} />
          ))}
        </ItemsContainer>
      )}
    </Section>
  );
}
