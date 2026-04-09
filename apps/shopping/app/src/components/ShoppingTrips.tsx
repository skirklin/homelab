import { useEffect } from "react";
import styled from "styled-components";
import { Button } from "antd";
import { ArrowLeftOutlined, PlusOutlined } from "@ant-design/icons";
import type { ShoppingTrip, CategoryDef } from "../types";
import { useShoppingBackend } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";

function formatCategoryId(categoryId: string, categories: CategoryDef[]): string {
  // Look up display name from categories, fall back to capitalized ID
  const cat = categories.find(c => c.id === categoryId);
  if (cat) return cat.name;
  // Fall back: capitalize first letter for legacy string categories
  return categoryId.charAt(0).toUpperCase() + categoryId.slice(1);
}

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

const TripCard = styled.div`
  background: var(--color-bg);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-md);
  overflow: hidden;
  border: 1px solid var(--color-border);
`;

const TripHeader = styled.div`
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg-muted);
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  display: flex;
  justify-content: space-between;
`;

const TripItems = styled.div`
  padding: var(--space-sm) var(--space-md);
`;

const TripItem = styled.div`
  padding: var(--space-xs) 0;
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid var(--color-border);

  &:last-child {
    border-bottom: none;
  }
`;

const ItemName = styled.span`
  color: var(--color-text);
  flex: 1;
`;

const ItemNote = styled.span`
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  margin-left: var(--space-xs);
`;

const ItemCategory = styled.span`
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  margin-right: var(--space-sm);
`;

const AddButton = styled(Button)`
  opacity: 0.6;
  &:hover {
    opacity: 1;
  }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: var(--space-2xl);
  color: var(--color-text-secondary);
`;

interface Props {
  trips: ShoppingTrip[];
  categories: CategoryDef[];
  userId: string;
  onBack: () => void;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays === 0) {
    return `Today at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } else if (diffDays === 1) {
    return `Yesterday at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "long" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

export function ShoppingTrips({ trips, categories, userId, onBack }: Props) {
  const shopping = useShoppingBackend();
  const { state } = useShoppingContext();

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

  const handleAddItem = (ingredient: string, note?: string) => {
    const listId = state.list?.id;
    if (!listId) return;
    shopping.addItem(listId, ingredient, userId, { note }).catch((error) => {
      console.error("Failed to add item:", error);
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
        <Title>Shopping History</Title>
      </Header>
      <Content>
        {trips.length === 0 ? (
          <EmptyState>
            <p>No shopping trips yet.</p>
            <p>Complete a shopping trip by checking items and tapping "Done".</p>
          </EmptyState>
        ) : (
          trips.map((trip) => (
            <TripCard key={trip.id}>
              <TripHeader>
                <span>{formatDate(trip.completedAt)}</span>
                <span>{trip.items.length} items</span>
              </TripHeader>
              <TripItems>
                {trip.items.map((item, index) => (
                  <TripItem key={index}>
                    <ItemName>
                      {item.ingredient}
                      {item.note && <ItemNote>({item.note})</ItemNote>}
                    </ItemName>
                    <ItemCategory>{formatCategoryId(item.categoryId, categories)}</ItemCategory>
                    <AddButton
                      type="text"
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => handleAddItem(item.ingredient, item.note)}
                    />
                  </TripItem>
                ))}
              </TripItems>
            </TripCard>
          ))
        )}
      </Content>
    </Container>
  );
}
