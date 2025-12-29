import { useDroppable } from "@dnd-kit/core";
import styled from "styled-components";
import type { GroceryItem, Category } from "../types";
import { GroceryItemRow } from "./GroceryItem";

function formatCategory(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

const Section = styled.div<{ $isEmpty: boolean }>`
  margin-bottom: ${(props) => (props.$isEmpty ? "2px" : "var(--space-md)")};
`;

const CategoryHeader = styled.div<{ $isOver: boolean; $isEmpty: boolean }>`
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
  category: Category;
  items: GroceryItem[];
}

export function CategorySection({ category, items }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: category,
    data: { category },
  });

  const isEmpty = items.length === 0;

  // Sort items by added time only (keep position stable when checking)
  const sortedItems = [...items].sort((a, b) => {
    return a.addedAt.getTime() - b.addedAt.getTime();
  });

  return (
    <Section ref={setNodeRef} $isEmpty={isEmpty}>
      <CategoryHeader $isOver={isOver} $isEmpty={isEmpty}>
        {formatCategory(category)}
        {!isEmpty && <ItemCount>({items.length})</ItemCount>}
      </CategoryHeader>
      {!isEmpty && (
        <ItemsContainer $isOver={isOver}>
          {sortedItems.map((item) => (
            <GroceryItemRow key={item.id} item={item} />
          ))}
        </ItemsContainer>
      )}
    </Section>
  );
}
