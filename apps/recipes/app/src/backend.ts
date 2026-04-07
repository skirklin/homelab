/**
 * Backend initialization and Cloud Functions stubs.
 * Cloud Functions will be replaced with custom PocketBase endpoints later.
 */
import { initializeBackend } from "@kirkl/shared";

// Initialize shared backend (PocketBase)
initializeBackend();

// ============================================
// Cloud Function stubs — not yet migrated
// ============================================

function notYetMigrated(name: string): never {
  throw new Error(`${name} is not yet migrated to PocketBase`);
}

export const getRecipes = async (_args: { url: string | undefined }): Promise<{ data: { error?: string; recipes: string } }> => {
  notYetMigrated("getRecipes");
};

export const generateRecipe = async (_args: { prompt: string }): Promise<{ data: { recipeJson: string } }> => {
  notYetMigrated("generateRecipe");
};

export const enrichRecipeManual = async (_args: { boxId: string; recipeId: string }): Promise<{ data: { success: boolean; enrichment: unknown } }> => {
  notYetMigrated("enrichRecipeManual");
};

export const modifyRecipe = async (_args: { boxId: string; recipeId: string; feedback: string }): Promise<{ data: { success: boolean; modificationJson: string } }> => {
  notYetMigrated("modifyRecipe");
};

export const addBoxOwner = async (_args: { boxId: string; newOwnerEmail: string }): Promise<void> => {
  notYetMigrated("addBoxOwner");
};

export const addRecipeOwner = async (_args: { boxId: string; recipeId: string; newOwnerEmail: string }): Promise<void> => {
  notYetMigrated("addRecipeOwner");
};

export const getOwnerInfo = async (_args: { ownerIds: string[] }): Promise<{ data: { owners: { uid: string; name: string | null; email: string | null }[] } }> => {
  notYetMigrated("getOwnerInfo");
};
