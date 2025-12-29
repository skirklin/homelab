import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Spin, Button } from "antd";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import styled from "styled-components";
import { useAppContext } from "../context";
import { subscribeToList, getItemsByCategory } from "../subscription";
import { updateItemCategory } from "../firestore";
import { Header } from "./Header";
import { AddItem } from "./AddItem";
import { CategorySection } from "./CategorySection";
import { ShoppingTrips } from "./ShoppingTrips";
import { ListSettings } from "./ListSettings";
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
    const newCategory = over.id as Category;

    if (item && newCategory && item.category !== newCategory) {
      updateItemCategory(item, newCategory);
    }
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

  const itemsByCategory = getItemsByCategory(state);
  const configuredCategories = state.list?.categories || [];

  // Always include "uncategorized" at the end for new items
  const categories = configuredCategories.includes("uncategorized")
    ? configuredCategories
    : [...configuredCategories, "uncategorized"];

  return (
    <Container>
      <Header
        listId={listId || ""}
        onShowHistory={() => setView("history")}
        onShowSettings={() => setView("settings")}
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
