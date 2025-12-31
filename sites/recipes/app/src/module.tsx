/**
 * Recipes module for embedding in the home app.
 * Provides routes that can be mounted at /recipes/*
 */
import { RecipesProvider } from "./context";
import { CookingModeProvider } from "./CookingModeContext";
import { RecipesRoutes } from "./RecipesRoutes";

export function RecipesModule() {
  return (
    <RecipesProvider>
      <CookingModeProvider>
        <RecipesRoutes />
      </CookingModeProvider>
    </RecipesProvider>
  );
}
