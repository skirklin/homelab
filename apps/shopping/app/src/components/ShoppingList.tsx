import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { Spin, Button } from "antd";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { appStorage, StorageKeys, collapsedCategoriesKey } from "../storage";
import { useShoppingContext } from "../shopping-context";
import { getItemsByCategoryId } from "../selectors";
import { Header } from "./Header";
import { AddItem } from "./AddItem";
import { CategorySection } from "./CategorySection";
import { ShoppingTrips } from "./ShoppingTrips";
import { ListSettings } from "./ListSettings";
import { UNCATEGORIZED_CATEGORY_ID, type CategoryDef } from "../types";

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
  const view = viewFromSplat(splat);

  // Standalone the URL is /<slug>(/history|/settings); embedded under the
  // home shell it's /shopping/<slug>(/history|/settings). Strip the splat
  // off location.pathname to recover the list-view path that works in both
  // mounts — beats wrestling with react-router's `..` semantics on splats.
  // String slicing (not regex) so any splat content goes uninterpreted.
  const listPath = stripSplatSuffix(location.pathname, splat);
  // Collapsed category ids, persisted per slug so refresh and list-switching
  // both restore the user's view. Read on slug change, write on every toggle.
  // Stored as an array under shopping:collapsed:<slug> because Set isn't
  // JSON-serializable.
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() =>
    new Set<string>(slug ? appStorage.get<string[]>(collapsedCategoriesKey(slug), []) : []),
  );

  // Look up listId from user's slugs
  const listId = slug ? state.userSlugs[slug] : undefined;

  // Save last-used list and subscribe to list data
  useEffect(() => {
    if (slug && listId) {
      appStorage.set(StorageKeys.LAST_LIST, slug);
      setCurrentList(listId);
    }
  }, [slug, listId, setCurrentList]);

  // Reload collapsed state when the slug changes (list switch). The
  // useState initializer only runs on mount, so without this the user
  // would see the previous list's collapse state on the new one.
  useEffect(() => {
    if (!slug) return;
    setCollapsedCategories(
      new Set<string>(appStorage.get<string[]>(collapsedCategoriesKey(slug), [])),
    );
  }, [slug]);

  const toggleCategoryCollapse = (categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      if (slug) {
        appStorage.set(collapsedCategoriesKey(slug), Array.from(next));
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
          <>
            {categories.map((category) => {
              const items = itemsByCategoryId.get(category.id) || [];
              // Hide the auto-appended "Uncategorized" pseudo-category when empty.
              // (User-configured categories stay visible even when empty so
              // users can see what's defined.)
              if (category.id === UNCATEGORIZED_CATEGORY_ID && items.length === 0) return null;
              return (
                <CategorySection
                  key={category.id}
                  category={category}
                  items={items}
                  collapsed={collapsedCategories.has(category.id)}
                  onToggleCollapse={() => toggleCategoryCollapse(category.id)}
                />
              );
            })}
          </>
        )}
      </Content>
    </Column>
  );
}
