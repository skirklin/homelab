import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import { Spin, Button } from "antd";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  pointerWithin,
  TouchSensor,
  MouseSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { appStorage, StorageKeys } from "../storage";

// Custom modifier: only snap Y axis to cursor center, keep original X offset
const snapVerticalToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;

  const event = activatorEvent as PointerEvent;
  // How far from the top of the element did we click? (use clientY for viewport-relative coords)
  const offsetY = event.clientY - draggingNodeRect.top;

  return {
    ...transform,
    // Adjust Y so element centers vertically on cursor
    y: transform.y + offsetY - draggingNodeRect.height / 2,
  };
};
import { useGroceriesContext } from "../groceries-context";
import { getItemsByCategoryId } from "../subscription";
import { updateItemCategory } from "../firestore";
import { Header } from "./Header";
import { AddItem } from "./AddItem";
import { CategorySection } from "./CategorySection";
import { ShoppingTrips } from "./ShoppingTrips";
import { ListSettings } from "./ListSettings";
import type { GroceryItem, CategoryId, CategoryDef } from "../types";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const StickyTop = styled.div`
  position: sticky;
  top: 0;
  z-index: 100;
`;

const Content = styled.main`
  flex: 1;
  padding-bottom: var(--space-xl);
`;

const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: var(--space-2xl);
`;

const DragItem = styled.div`
  padding: var(--space-sm) var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
`;

const NotFoundContainer = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const NotFoundHeader = styled.header`
  padding: var(--space-md);
  background: var(--color-primary);
  color: white;
`;

const NotFoundTitle = styled.h1`
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
`;

const NotFoundContent = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-xl);
  text-align: center;
  gap: var(--space-md);
`;

const NotFoundText = styled.p`
  color: var(--color-text-secondary);
  font-size: var(--font-size-lg);
  margin: 0;
`;

type View = "list" | "history" | "settings";

interface GroceryListProps {
  embedded?: boolean;
}

export function GroceryList({ embedded = false }: GroceryListProps) {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { state, setCurrentList } = useGroceriesContext();
  const [view, setView] = useState<View>("list");
  const [draggedItem, setDraggedItem] = useState<GroceryItem | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Configure sensors for both mouse and touch with activation delay
  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: 10, // 10px movement required before drag starts
    },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: 200, // 200ms hold before drag starts on touch
      tolerance: 5, // 5px movement allowed during delay
    },
  });
  const sensors = useSensors(mouseSensor, touchSensor);

  // Look up listId from user's slugs
  const listId = slug ? state.userSlugs[slug] : undefined;

  // Save last-used list and subscribe to list data
  useEffect(() => {
    if (slug && listId) {
      appStorage.set(StorageKeys.LAST_LIST, slug);
      setCurrentList(listId);
    }
  }, [slug, listId, setCurrentList]);

  const handleDragStart = (event: DragStartEvent) => {
    const item = event.active.data.current?.item as GroceryItem;
    setDraggedItem(item);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedItem(null);

    const { active, over } = event;
    if (!over) return;

    const item = active.data.current?.item as GroceryItem;
    const newCategoryId = over.id as CategoryId;

    if (item && newCategoryId && item.categoryId !== newCategoryId) {
      updateItemCategory(item, newCategoryId);
    }
  };

  const toggleCategoryCollapse = (categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  // Slug not found in user's mapping
  if (slug && !listId) {
    return (
      <NotFoundContainer>
        <NotFoundHeader>
          <NotFoundTitle>List Not Found</NotFoundTitle>
        </NotFoundHeader>
        <NotFoundContent>
          <NotFoundText>
            You don't have a list called "/{slug}"
          </NotFoundText>
          <Button type="primary" onClick={() => navigate("..")}>
            Go to My Lists
          </Button>
        </NotFoundContent>
      </NotFoundContainer>
    );
  }

  if (view === "history") {
    return (
      <ShoppingTrips
        trips={state.trips}
        categories={state.list?.categories || []}
        userId={user?.uid || ""}
        onBack={() => setView("list")}
      />
    );
  }

  if (view === "settings") {
    return (
      <ListSettings
        slug={slug || ""}
        listId={listId || ""}
        onBack={() => setView("list")}
      />
    );
  }

  const itemsByCategoryId = getItemsByCategoryId(state);
  const configuredCategories = state.list?.categories || [];

  // Always include "uncategorized" at the end for new items
  const uncategorizedDef: CategoryDef = { id: "uncategorized", name: "Uncategorized" };
  const hasUncategorized = configuredCategories.some(c => c.id === "uncategorized");
  const categories = hasUncategorized
    ? configuredCategories
    : [...configuredCategories, uncategorizedDef];

  return (
    <Container>
      <StickyTop>
        <Header
          listId={listId || ""}
          onShowHistory={() => setView("history")}
          onShowSettings={() => setView("settings")}
          embedded={embedded}
        />
        <AddItem />
      </StickyTop>
      <Content>
        {state.loading ? (
          <LoadingContainer>
            <Spin size="large" />
          </LoadingContainer>
        ) : (
          <DndContext
              sensors={sensors}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              collisionDetection={pointerWithin}
              measuring={{
                droppable: {
                  strategy: MeasuringStrategy.Always,
                },
              }}
            >
            {categories.map((category) => (
              <CategorySection
                key={category.id}
                category={category}
                items={itemsByCategoryId.get(category.id) || []}
                collapsed={collapsedCategories.has(category.id)}
                onToggleCollapse={() => toggleCategoryCollapse(category.id)}
                forceCollapse={draggedItem !== null}
              />
            ))}
            {createPortal(
              <DragOverlay modifiers={[snapVerticalToCursor]}>
                {draggedItem ? (
                  <DragItem data-testid="drag-overlay">
                    {draggedItem.ingredient}
                    {draggedItem.note && ` (${draggedItem.note})`}
                  </DragItem>
                ) : null}
              </DragOverlay>,
              document.body
            )}
          </DndContext>
        )}
      </Content>
    </Container>
  );
}
