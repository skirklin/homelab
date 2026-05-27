import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate, useLocation } from "react-router-dom";
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
import { useShoppingContext } from "../shopping-context";
import { getItemsByCategoryId } from "../selectors";
import { useShoppingBackend } from "@kirkl/shared";
import { Header } from "./Header";
import { AddItem } from "./AddItem";
import { CategorySection } from "./CategorySection";
import { ShoppingTrips } from "./ShoppingTrips";
import { ListSettings } from "./ListSettings";
import { UNCATEGORIZED_CATEGORY_ID, type ShoppingItem, type CategoryId, type CategoryDef } from "../types";

// Shopping owns its own 600px column in both standalone and embedded modes.
// In standalone, the box-shadow gives the desktop card look; on narrow
// viewports the shadow drops away so the column sits flush. In embedded mode
// the home shell paints its own page background, so we suppress the shadow
// to avoid stacking two cards.
const Column = styled.div<{ $embedded: boolean }>`
  max-width: 600px;
  margin: 0 auto;
  background: var(--color-bg);
  ${(p) => (p.$embedded ? "" : "box-shadow: var(--shadow-md);")}

  @media (max-width: 600px) {
    box-shadow: none;
  }
`;

const Content = styled.main`
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
  min-height: 100dvh;
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

// Derive the current sub-view from the URL suffix. The route is mounted as
// `/:slug/*`, so the wildcard '*' param is "" for /<slug>, "history" for
// /<slug>/history, "settings" for /<slug>/settings. Anything else (typos,
// stale bookmarks) falls back to the list view.
function viewFromSplat(splat: string | undefined): View {
  if (splat === "history") return "history";
  if (splat === "settings") return "settings";
  return "list";
}

function stripSplatSuffix(pathname: string, splat: string | undefined): string {
  if (!splat) return pathname;
  if (pathname.endsWith(`/${splat}/`)) return pathname.slice(0, -(splat.length + 2));
  if (pathname.endsWith(`/${splat}`)) return pathname.slice(0, -(splat.length + 1));
  return pathname;
}

interface ShoppingListProps {
  embedded?: boolean;
}

export function ShoppingList({ embedded = false }: ShoppingListProps) {
  const { slug, "*": splat } = useParams<{ slug: string; "*": string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { state, setCurrentList } = useShoppingContext();
  const shopping = useShoppingBackend();
  const view = viewFromSplat(splat);

  // Standalone the URL is /<slug>(/history|/settings); embedded under the
  // home shell it's /shopping/<slug>(/history|/settings). Strip the splat
  // off location.pathname to recover the list-view path that works in both
  // mounts — beats wrestling with react-router's `..` semantics on splats.
  // String slicing (not regex) so any splat content goes uninterpreted.
  const listPath = stripSplatSuffix(location.pathname, splat);
  const [draggedItem, setDraggedItem] = useState<ShoppingItem | null>(null);
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
    const item = event.active.data.current?.item as ShoppingItem;
    setDraggedItem(item);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedItem(null);

    const { active, over } = event;
    if (!over) return;

    const item = active.data.current?.item as ShoppingItem;
    const newCategoryId = over.id as CategoryId;

    if (item && newCategoryId && item.categoryId !== newCategoryId && listId) {
      shopping.updateItemCategory(item.id, newCategoryId);
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
          <Button type="primary" onClick={() => navigate({ pathname: "..", search: "?pick=true" })}>
            Go to My Lists
          </Button>
        </NotFoundContent>
      </NotFoundContainer>
    );
  }

  // Back from a sub-view: if we have prior in-app history to pop, use it
  // (preserves scroll + matches the browser-back gesture). Otherwise — e.g.
  // the user refreshed on /<slug>/settings or landed via deep-link — fall
  // back to navigating up to the list. `location.key === "default"` is the
  // sentinel react-router sets on the *initial* entry of a session.
  const goBackToList = () => {
    if (location.key !== "default") {
      navigate(-1);
    } else {
      navigate(listPath, { replace: true });
    }
  };

  if (view === "history") {
    return (
      <ShoppingTrips
        trips={state.trips}
        categories={state.list?.categories || []}
        userId={user?.uid || ""}
        onBack={goBackToList}
      />
    );
  }

  if (view === "settings") {
    return (
      <ListSettings
        slug={slug || ""}
        listId={listId || ""}
        onBack={goBackToList}
      />
    );
  }

  const itemsByCategoryId = getItemsByCategoryId(state);
  const configuredCategories = state.list?.categories || [];

  // Always include the uncategorized pseudo-category at the end for new items
  const uncategorizedDef: CategoryDef = { id: UNCATEGORIZED_CATEGORY_ID, name: "Uncategorized" };
  const hasUncategorized = configuredCategories.some(c => c.id === UNCATEGORIZED_CATEGORY_ID);
  const categories = hasUncategorized
    ? configuredCategories
    : [...configuredCategories, uncategorizedDef];

  return (
    <Column $embedded={embedded}>
      <Header
        listId={listId || ""}
        onShowHistory={() => navigate(`${listPath}/history`)}
        onShowSettings={() => navigate(`${listPath}/settings`)}
        embedded={embedded}
      />
      <AddItem />
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
            {categories.map((category) => {
              const items = itemsByCategoryId.get(category.id) || [];
              // Hide the auto-appended "Uncategorized" pseudo-category when empty.
              // User-configured categories stay visible even when empty so they
              // remain drop targets for drag-and-drop.
              if (category.id === UNCATEGORIZED_CATEGORY_ID && items.length === 0) return null;
              return (
                <CategorySection
                  key={category.id}
                  category={category}
                  items={items}
                  collapsed={collapsedCategories.has(category.id)}
                  onToggleCollapse={() => toggleCategoryCollapse(category.id)}
                  forceCollapse={draggedItem !== null}
                />
              );
            })}
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
    </Column>
  );
}
