import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import { Spin, Button } from "antd";
import { DndContext, DragOverlay, MeasuringStrategy, pointerWithin, type DragEndEvent, type DragStartEvent, type Modifier } from "@dnd-kit/core";
import styled from "styled-components";

// Custom modifier: only snap Y axis to cursor center, keep original X offset
const snapVerticalToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;

  const event = activatorEvent as PointerEvent;
  // How far from the top of the element did we click?
  const offsetY = event.pageY - draggingNodeRect.top;

  return {
    ...transform,
    // Adjust Y so element centers vertically on cursor
    y: transform.y + offsetY - draggingNodeRect.height / 2,
  };
};
import { useAppContext } from "../context";
import { subscribeToList, getItemsByCategoryId } from "../subscription";
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

export function GroceryList() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { state, dispatch } = useAppContext();
  const currentListIdRef = useRef<string | null>(null);
  const unsubscribersRef = useRef<(() => void)[]>([]);
  const [view, setView] = useState<View>("list");
  const [draggedItem, setDraggedItem] = useState<GroceryItem | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Look up listId from user's slugs
  const listId = slug ? state.userSlugs[slug] : undefined;

  useEffect(() => {
    if (!state.authUser || !listId) return;

    // Only resubscribe if the list ID changed
    if (currentListIdRef.current === listId) return;

    // Cleanup previous subscriptions
    unsubscribersRef.current.forEach((unsub) => unsub());
    unsubscribersRef.current = [];

    currentListIdRef.current = listId;

    subscribeToList(listId, state.authUser.uid, dispatch).then((unsubs) => {
      unsubscribersRef.current = unsubs;
    });

    return () => {
      unsubscribersRef.current.forEach((unsub) => unsub());
    };
  }, [state.authUser, listId, dispatch]);

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
          <Button type="primary" onClick={() => navigate("/")}>
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
        userId={state.authUser?.uid || ""}
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
                  <DragItem>{draggedItem.name}</DragItem>
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
