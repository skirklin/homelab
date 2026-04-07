import { useDroppable } from "@dnd-kit/core";
import { DownOutlined, RightOutlined } from "@ant-design/icons";
import styled from "styled-components";
import type { ShoppingItem, CategoryDef } from "../types";
import { ShoppingItemRow } from "./ShoppingItem";

const Section = styled.div`
  margin-bottom: var(--space-xs);
`;

const CategoryHeader = styled.div<{ $isOver: boolean }>`
  display: flex;
  align-items: center;
  padding: var(--space-xs) var(--space-sm);
  background: ${(props) =>
    props.$isOver ? "var(--color-primary-light, #b8e6e6)" : "var(--color-bg-muted)"};
  font-weight: 600;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  transition: background 0.2s;
  user-select: none;
  cursor: pointer;
  gap: var(--space-xs);
`;

const CollapseIcon = styled.span`
  font-size: 10px;
  display: flex;
  align-items: center;
`;

const ItemCount = styled.span`
  margin-left: var(--space-sm);
  font-weight: 400;
  color: var(--color-text-muted);
`;

const ItemsContainer = styled.div<{ $isOver: boolean; $collapsed: boolean; $forceCollapse: boolean }>`
  background: ${(props) =>
    props.$isOver ? "var(--color-primary-light, #e6f7f7)" : "var(--color-bg)"};
  transition: ${(props) => props.$forceCollapse ? "none" : "background 0.2s, max-height 0.2s, opacity 0.2s"};
  overflow: hidden;
  max-height: ${(props) => (props.$collapsed ? "0" : "2000px")};
  opacity: ${(props) => (props.$collapsed ? 0 : 1)};
`;

interface Props {
  category: CategoryDef;
  items: ShoppingItem[];
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

  // Sort items by added time only (keep position stable when checking)
  const sortedItems = [...items].sort((a, b) => {
    return a.addedAt.getTime() - b.addedAt.getTime();
  });

  const isCollapsed = forceCollapse || collapsed;

  return (
    <Section ref={setNodeRef}>
      <CategoryHeader $isOver={isOver} onClick={onToggleCollapse} data-testid="category-header">
        <CollapseIcon>
          {isCollapsed ? <RightOutlined /> : <DownOutlined />}
        </CollapseIcon>
        {category.name}
        {!isEmpty && <ItemCount>({items.length})</ItemCount>}
      </CategoryHeader>
      <ItemsContainer $isOver={isOver} $collapsed={isCollapsed} $forceCollapse={!!forceCollapse}>
        {sortedItems.map((item) => (
          <ShoppingItemRow key={item.id} item={item} />
        ))}
      </ItemsContainer>
    </Section>
  );
}
