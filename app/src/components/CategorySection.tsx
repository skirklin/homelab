import styled from "styled-components";
import type { GroceryItem, Category } from "../types";
import { GroceryItemRow } from "./GroceryItem";
import { CATEGORY_LABELS } from "../types";

const Section = styled.div`
  margin-bottom: var(--space-md);
`;

const CategoryHeader = styled.div`
  display: flex;
  align-items: center;
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg-muted);
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const ItemCount = styled.span`
  margin-left: var(--space-sm);
  font-weight: 400;
  color: var(--color-text-muted);
`;

const ItemsContainer = styled.div`
  background: var(--color-bg);
`;

interface Props {
  category: Category;
  items: GroceryItem[];
}

export function CategorySection({ category, items }: Props) {
  // Sort items by added time only (keep position stable when checking)
  const sortedItems = [...items].sort((a, b) => {
    return a.addedAt.getTime() - b.addedAt.getTime();
  });

  return (
    <Section>
      <CategoryHeader>
        {CATEGORY_LABELS[category]}
        <ItemCount>({items.length})</ItemCount>
      </CategoryHeader>
      <ItemsContainer>
        {sortedItems.map((item) => (
          <GroceryItemRow key={item.id} item={item} />
        ))}
      </ItemsContainer>
    </Section>
  );
}
