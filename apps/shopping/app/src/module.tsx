/**
 * ShoppingModule - Embeddable shopping app component
 *
 * This module can be used standalone or embedded in another app.
 * It expects the parent to provide authentication via @kirkl/shared AuthProvider.
 */

import { Routes, Route } from "react-router-dom";
import { useAuth, NotFound } from "@kirkl/shared";
import { BackendProvider } from "@kirkl/shared";
import { ShoppingProvider } from "./shopping-context";
import { ShoppingList } from "./components/ShoppingList";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
// Storage is imported to trigger legacy key migration on startup
import "./storage";

interface ShoppingRoutesProps {
  /** When true, hides sign-out and other account actions (handled by parent shell) */
  embedded?: boolean;
}

export function ShoppingRoutes({ embedded = false }: ShoppingRoutesProps) {
  const { user } = useAuth();

  if (!user) {
    return null;
  }

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/join/:listId" element={<JoinList />} />
      {/* Wildcard so /:slug/history and /:slug/settings hit the same component,
          which derives its current sub-view from the URL. Bundle 2 of the
          nav audit — putting view in state instead of the URL meant refresh
          / browser-back / deep-link all silently dropped you back to the list. */}
      <Route path="/:slug/*" element={<ShoppingList embedded={embedded} />} />
      {/* Catch-all — must come after /:slug/* so it only fires on unmatched
          top-level routes (e.g. /typo, not /grocery/anything). */}
      <Route path="*" element={<NotFound homePath={embedded ? "/shopping" : "/"} />} />
    </Routes>
  );
}

export function ShoppingModule() {
  return (
    <BackendProvider>
      <ShoppingProvider>
        <ShoppingRoutes />
      </ShoppingProvider>
    </BackendProvider>
  );
}

// Re-export provider for standalone use
export { ShoppingProvider, useShoppingContext } from "./shopping-context";
export { useShoppingBackend } from "@kirkl/shared";
// Suggestion derivation — exposed for the home shell's recipe → shopping bridge
// so it uses the same trip-derived source of truth as the AddItem UI.
export { deriveSuggestions, type Suggestion } from "./suggestions";
