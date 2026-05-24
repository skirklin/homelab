import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { Button, Input } from "antd";
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useFeedback } from "@kirkl/shared";
import { UNCATEGORIZED_CATEGORY_ID, type ShoppingTrip, type CategoryDef } from "../types";
import { useShoppingBackend } from "@kirkl/shared";
import { useShoppingContext } from "../shopping-context";
import { deriveSuggestions } from "../suggestions";

function formatCategoryId(categoryId: string, categories: CategoryDef[]): string {
  // Look up display name from categories, fall back to capitalized ID
  const cat = categories.find(c => c.id === categoryId);
  if (cat) return cat.name;
  // Fall back: capitalize first letter for legacy string categories
  return categoryId.charAt(0).toUpperCase() + categoryId.slice(1);
}

const Container = styled.div`
  min-height: 100vh;
  min-height: 100dvh;
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
  align-items: center;
  gap: var(--space-xs);
  border-bottom: 1px solid var(--color-border);

  &:last-child {
    border-bottom: none;
  }
`;

const ItemMain = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
`;

const ItemName = styled.span`
  color: var(--color-text);
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

const RowButton = styled(Button)`
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
  const { modal, message } = useFeedback();
  const suggestions = useMemo(() => deriveSuggestions(state.trips), [state.trips]);

  // Inline edit state: which (tripId, itemIndex) is currently being renamed.
  // Compound key avoids the cross-trip name collision a plain `${index}` would
  // produce — and we want one editor open at a time across the whole view.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Handle Escape key to go back (when not editing)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingKey === null) {
        onBack();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack, editingKey]);

  const handleAddItem = (ingredient: string, note?: string) => {
    const listId = state.list?.id;
    if (!listId) return;
    const normalized = ingredient.toLowerCase().trim();
    const suggestion = suggestions.get(normalized);
    const categoryId = suggestion?.categoryId || UNCATEGORIZED_CATEGORY_ID;
    // wpb handles transient errors by queueing for retry; permanent errors
    // bubble up as unhandled WrappedPbError rejections that the global
    // useOptimisticErrorToast surfaces. Locally catching here would
    // swallow both and produce silent data loss.
    void shopping.addItem(listId, ingredient, userId, categoryId, note);
  };

  const startEdit = (tripId: string, index: number, current: string) => {
    setEditingKey(`${tripId}:${index}`);
    setEditValue(current);
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue("");
  };

  const saveEdit = async (tripId: string, index: number, currentIngredient: string) => {
    const next = editValue.trim();
    if (!next) {
      message.warning("Name cannot be empty");
      return;
    }
    if (next === currentIngredient) {
      cancelEdit();
      return;
    }
    try {
      await shopping.updateTripItem(tripId, index, { ingredient: next });
      cancelEdit();
    } catch (err) {
      console.error("Failed to rename trip item:", err);
      message.error("Failed to rename");
    }
  };

  const handleDelete = (tripId: string, index: number, name: string) => {
    modal.confirm({
      title: `Delete "${name}" from this trip?`,
      content: "Future autocomplete will no longer suggest this name from this trip.",
      okText: "Delete",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await shopping.removeTripItem(tripId, index);
        } catch (err) {
          console.error("Failed to delete trip item:", err);
          message.error("Failed to delete");
        }
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
                {trip.items.map((item, index) => {
                  const key = `${trip.id}:${index}`;
                  const isEditing = editingKey === key;
                  return (
                    <TripItem key={index}>
                      {isEditing ? (
                        <>
                          <Input
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onPressEnter={() => saveEdit(trip.id, index, item.ingredient)}
                            autoFocus
                            size="small"
                            style={{ flex: 1 }}
                          />
                          <Button
                            type="text"
                            size="small"
                            icon={<CheckOutlined />}
                            onClick={() => saveEdit(trip.id, index, item.ingredient)}
                          />
                          <Button
                            type="text"
                            size="small"
                            icon={<CloseOutlined />}
                            onClick={cancelEdit}
                          />
                        </>
                      ) : (
                        <>
                          <ItemMain>
                            <ItemName>
                              {item.ingredient}
                              {item.note && <ItemNote>({item.note})</ItemNote>}
                            </ItemName>
                          </ItemMain>
                          <ItemCategory>{formatCategoryId(item.categoryId, categories)}</ItemCategory>
                          <RowButton
                            type="text"
                            size="small"
                            icon={<EditOutlined />}
                            aria-label={`Edit ${item.ingredient}`}
                            onClick={() => startEdit(trip.id, index, item.ingredient)}
                          />
                          <RowButton
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={`Delete ${item.ingredient}`}
                            onClick={() => handleDelete(trip.id, index, item.ingredient)}
                          />
                          <RowButton
                            type="text"
                            size="small"
                            icon={<PlusOutlined />}
                            aria-label={`Add ${item.ingredient} to current list`}
                            onClick={() => handleAddItem(item.ingredient, item.note)}
                          />
                        </>
                      )}
                    </TripItem>
                  );
                })}
              </TripItems>
            </TripCard>
          ))
        )}
      </Content>
    </Container>
  );
}
