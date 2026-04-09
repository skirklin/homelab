/**
 * Recipes module for embedding in the home app.
 * Provides routes that can be mounted at /recipes/*
 */
import { BackendProvider } from "@kirkl/shared";
import { RecipesProvider } from "./context";
import { CookingModeProvider } from "./CookingModeContext";
import { RecipesRoutes } from "./RecipesRoutes";

export function RecipesModule() {
  return (
    <BackendProvider>
      <RecipesProvider>
        <CookingModeProvider>
          <RecipesRoutes />
        </CookingModeProvider>
      </RecipesProvider>
    </BackendProvider>
  );
}

// Export providers and routes separately for home app integration
export { BackendProvider as RecipesBackendProvider } from "@kirkl/shared";
export { RecipesProvider, useRecipesContext } from "./context";
export { CookingModeProvider } from "./CookingModeContext";
export { RecipesRoutes } from "./RecipesRoutes";
export { PublicRecipe } from "./routes/PublicRecipe";
export { ShoppingIntegrationContext, useShoppingIntegration } from "./ShoppingIntegrationContext";
