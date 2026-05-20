import type { AppState, BoxId, RecipeId, UserId } from './types';

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

export function getUserFromState(state: AppState, userId: UserId) {
  return state.users.get(userId)
}
