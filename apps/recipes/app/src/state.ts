import type { AppState, BoxId, RecipeId } from './types';

export function getRecipeFromState(state: AppState, boxId: BoxId, recipeId: RecipeId) {
  const box = state.boxes.get(boxId);
  if (box === undefined) {
    return
  }
  return box.recipes.get(recipeId)
}

export function getBoxFromState(state: AppState, boxId: BoxId) {
  return state.boxes.get(boxId);
}

export function getAppUserFromState(state: AppState, userId: string | undefined) {
  if (!userId) {
    return undefined
  }
  return state.users.get(userId)
}
