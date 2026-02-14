/**
 * GroceriesModule - Embeddable groceries app component
 *
 * This module can be used standalone or embedded in another app.
 * It expects the parent to provide authentication via @kirkl/shared AuthProvider.
 */

import { Routes, Route } from "react-router-dom";
import { useAuth } from "@kirkl/shared";
import { GroceriesProvider } from "./groceries-context";
import { GroceryList } from "./components/GroceryList";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
// Storage is imported to trigger legacy key migration on startup
import "./storage";

interface GroceriesRoutesProps {
  /** When true, hides sign-out and other account actions (handled by parent shell) */
  embedded?: boolean;
}

export function GroceriesRoutes({ embedded = false }: GroceriesRoutesProps) {
  const { user } = useAuth();

  if (!user) {
    return null;
  }

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/join/:listId" element={<JoinList />} />
      <Route path="/:slug" element={<GroceryList embedded={embedded} />} />
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
export { addItem as addGroceryItem, setCurrentListId } from "./firestore";
