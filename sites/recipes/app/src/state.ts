import { BoxEntry, RecipeEntry } from './storage';
import { AppState, BoxId, RecipeId, UserId } from './types';

export function getRecipeFromState(state: AppState, boxId: BoxId, recipeId: RecipeId) {
  const box = state.boxes.get(boxId);
  if (box === undefined) {
    return
  }
  return box.recipes.get(recipeId)
}

export function setRecipeInState(state: AppState, boxId: BoxId, recipeId: RecipeId, recipe: RecipeEntry) {
  const box = state.boxes.get(boxId);
  if (box === undefined) {
    return
  }
  return box.recipes.set(recipeId, recipe)
}

export function getBoxFromState(state: AppState, boxId: BoxId) {
  return state.boxes.get(boxId);
}

export function setBoxInState(state: AppState, boxId: BoxId, box: BoxEntry) {
  state.boxes.set(boxId, box);
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
