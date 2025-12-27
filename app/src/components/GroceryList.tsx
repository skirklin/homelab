import { useEffect, useState } from "react";
import { Spin } from "antd";
import styled from "styled-components";
import { useAppContext } from "../context";
import { subscribeToData, getItemsByCategory } from "../subscription";
import { Header } from "./Header";
import { AddItem } from "./AddItem";
import { CategorySection } from "./CategorySection";
import { CATEGORIES } from "../types";

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

const EmptyState = styled.div`
  text-align: center;
  padding: var(--space-2xl);
  color: var(--color-text-secondary);
`;

export function GroceryList() {
  const { state, dispatch } = useAppContext();
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (!state.authUser || subscribed) return;

    let unsubscribers: (() => void)[] = [];

    subscribeToData(state.authUser.uid, dispatch).then((unsubs) => {
      unsubscribers = unsubs;
      setSubscribed(true);
    });

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [state.authUser, dispatch, subscribed]);

  const itemsByCategory = getItemsByCategory(state);
  const hasItems = state.items.size > 0;

  // Filter to only categories that have items, in preferred order
  const activeCategories = CATEGORIES.filter((cat) =>
    itemsByCategory.has(cat)
  );

  return (
    <Container>
      <Header />
      <AddItem />
      <Content>
        {state.loading ? (
          <LoadingContainer>
            <Spin size="large" />
          </LoadingContainer>
        ) : !hasItems ? (
          <EmptyState>
            <p>Your grocery list is empty.</p>
            <p>Add items above to get started!</p>
          </EmptyState>
        ) : (
          activeCategories.map((category) => (
            <CategorySection
              key={category}
              category={category}
              items={itemsByCategory.get(category)!}
            />
          ))
        )}
      </Content>
    </Container>
  );
}
