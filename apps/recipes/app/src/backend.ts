import { initializeBackend, getBackend } from "@kirkl/shared";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

// Initialize shared backend with recipes auth domain
initializeBackend("recipes.kirkl.in");

const { app, db, auth } = getBackend();
export { app, db, auth };

const functions = getFunctions(app);
if (import.meta.env.DEV) {
  connectFunctionsEmulator(functions, "localhost", 5001);
}

export const getRecipes = httpsCallable(functions, 'getRecipes');
export const addBoxOwner = httpsCallable(functions, 'addBoxOwner');
export const addRecipeOwner = httpsCallable(functions, 'addRecipeOwner');
export const generateRecipe = httpsCallable<{ prompt: string }, { recipeJson: string }>(functions, 'generateRecipe');
export const enrichRecipeManual = httpsCallable<{ boxId: string, recipeId: string }, { success: boolean, enrichment: unknown }>(functions, 'enrichRecipeManual');
export const modifyRecipe = httpsCallable<
  { boxId: string, recipeId: string, feedback: string },
  { success: boolean, modificationJson: string }
>(functions, 'modifyRecipe');
export const getOwnerInfo = httpsCallable<
  { ownerIds: string[] },
  { owners: { uid: string, name: string | null, email: string | null }[] }
>(functions, 'getOwnerInfo');
