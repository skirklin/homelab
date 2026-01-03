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

// Export providers and routes separately for home app integration
export { RecipesProvider, useRecipesContext } from "./context";
export { CookingModeProvider } from "./CookingModeContext";
export { RecipesRoutes } from "./RecipesRoutes";
export { PublicRecipe } from "./routes/PublicRecipe";
