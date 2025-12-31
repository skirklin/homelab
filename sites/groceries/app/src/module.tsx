/**
 * GroceriesModule - Embeddable groceries app component
 *
 * This module can be used standalone or embedded in another app.
 * It expects the parent to provide authentication via @kirkl/shared AuthProvider.
 */

import { useEffect, useRef } from "react";
import { Routes, Route } from "react-router-dom";
import { useAuth } from "@kirkl/shared";
import { GroceriesProvider, useGroceriesContext } from "./groceries-context";
import { subscribeToUserSlugs } from "./subscription";
import { GroceryList } from "./components/GroceryList";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
import { appStorage } from "./storage";

// Migrate legacy localStorage keys on startup
appStorage.migrateFromLegacy();

function GroceriesRoutes() {
  const { user } = useAuth();
  const { dispatch } = useGroceriesContext();
  const slugsUnsubRef = useRef<(() => void) | null>(null);

  // Subscribe to user's slugs when authenticated
  useEffect(() => {
    if (user) {
      slugsUnsubRef.current = subscribeToUserSlugs(user.uid, dispatch);
    }
    return () => {
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
    };
  }, [user, dispatch]);

  if (!user) {
    return null;
  }

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/join/:listId" element={<JoinList />} />
      <Route path="/:slug" element={<GroceryList />} />
    </Routes>
  );
}

export function GroceriesModule() {
  return (
    <GroceriesProvider>
      <GroceriesRoutes />
    </GroceriesProvider>
  );
}

// Re-export provider for standalone use
export { GroceriesProvider, useGroceriesContext } from "./groceries-context";
