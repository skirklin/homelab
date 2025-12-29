import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Spin } from "antd";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import styled from "styled-components";
import { useAppContext } from "../context";
import { subscribeToList, getItemsByCategory } from "../subscription";
import { updateItemCategory } from "../firestore";
import { Header } from "./Header";
import { AddItem } from "./AddItem";
import { CategorySection } from "./CategorySection";
import { ShoppingTrips } from "./ShoppingTrips";
import { CategorySettings } from "./CategorySettings";
import { ListPicker } from "./ListPicker";
import type { GroceryItem, Category } from "../types";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
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

type View = "list" | "history" | "settings" | "lists";

export function GroceryList() {
  const { listId } = useParams<{ listId?: string }>();
  const { state, dispatch } = useAppContext();
  const currentListIdRef = useRef<string | null>(null);
  const unsubscribersRef = useRef<(() => void)[]>([]);
  const [view, setView] = useState<View>("list");
  const [draggedItem, setDraggedItem] = useState<GroceryItem | null>(null);

  // Use "default" if no listId in URL (base path behavior)
  const effectiveListId = listId || "default";

  useEffect(() => {
    if (!state.authUser) return;

    // Only resubscribe if the list ID changed
    if (currentListIdRef.current === effectiveListId) return;

    // Cleanup previous subscriptions
    unsubscribersRef.current.forEach((unsub) => unsub());
    unsubscribersRef.current = [];

    currentListIdRef.current = effectiveListId;

    subscribeToList(effectiveListId, state.authUser.uid, dispatch).then((unsubs) => {
      unsubscribersRef.current = unsubs;
    });

    return () => {
      unsubscribersRef.current.forEach((unsub) => unsub());
    };
  }, [state.authUser, effectiveListId, dispatch]);

  const handleDragStart = (event: DragStartEvent) => {
    const item = event.active.data.current?.item as GroceryItem;
    setDraggedItem(item);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedItem(null);

    const { active, over } = event;
    if (!over) return;

    const item = active.data.current?.item as GroceryItem;
    const newCategory = over.id as Category;

    if (item && newCategory && item.category !== newCategory) {
      updateItemCategory(item, newCategory);
    }
  };

  if (view === "lists") {
    return (
      <ListPicker onBack={() => setView("list")} />
    );
  }

  if (view === "history") {
    return (
      <ShoppingTrips
        trips={state.trips}
        userId={state.authUser?.uid || ""}
        onBack={() => setView("list")}
      />
    );
  }

  if (view === "settings") {
    return (
      <CategorySettings
        categories={state.list?.categories || []}
        onBack={() => setView("list")}
      />
    );
  }

  const itemsByCategory = getItemsByCategory(state);
  const configuredCategories = state.list?.categories || [];

  // Always include "uncategorized" at the end for new items
  const categories = configuredCategories.includes("uncategorized")
    ? configuredCategories
    : [...configuredCategories, "uncategorized"];

  return (
    <Container>
      <Header
        onShowHistory={() => setView("history")}
        onShowSettings={() => setView("settings")}
        onShowLists={() => setView("lists")}
      />
      <AddItem />
      <Content>
        {state.loading ? (
          <LoadingContainer>
            <Spin size="large" />
          </LoadingContainer>
        ) : (
          <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            {categories.map((category) => (
              <CategorySection
                key={category}
                category={category}
                items={itemsByCategory.get(category) || []}
              />
            ))}
            <DragOverlay>
              {draggedItem ? (
                <DragItem>{draggedItem.name}</DragItem>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </Content>
    </Container>
  );
}
