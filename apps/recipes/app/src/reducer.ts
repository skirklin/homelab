import _ from 'lodash';
import { type PlainBox, type PlainRecipe, type PlainUser } from './storage';
import type { ActionType, AppState } from './types';

export function initState(): AppState {
  return (
    {
      boxes: new Map<string, PlainBox>(),
      writeable: true,
      users: new Map<string, PlainUser>(),
      loading: 0,
      subscriptionsReady: false,
    }
  )
}

// Produce a new AppState where `box.recipes.get(recipeId)` has been replaced
// by the result of `mut(recipe)`. Everything along the path (boxes Map, box,
// recipes Map, recipe) is reconstructed so React sees new references.
function withRecipe(
  prevState: AppState,
  boxId: string,
  recipeId: string,
  mut: (recipe: PlainRecipe) => PlainRecipe,
): AppState {
  const box = prevState.boxes.get(boxId);
  if (box === undefined) return prevState;
  const recipe = box.recipes.get(recipeId);
  if (recipe === undefined) return prevState;
  const newRecipe = mut(recipe);
  const newRecipes = new Map(box.recipes);
  newRecipes.set(recipeId, newRecipe);
  const newBox: PlainBox = { ...box, recipes: newRecipes };
  const newBoxes = new Map(prevState.boxes);
  newBoxes.set(boxId, newBox);
  return { ...prevState, boxes: newBoxes };
}

function withBox(
  prevState: AppState,
  boxId: string,
  mut: (box: PlainBox) => PlainBox,
): AppState {
  const box = prevState.boxes.get(boxId);
  if (box === undefined) return prevState;
  const newBox = mut(box);
  const newBoxes = new Map(prevState.boxes);
  newBoxes.set(boxId, newBox);
  return { ...prevState, boxes: newBoxes };
}

function handleRecipeChange(key: string, prevState: AppState, action: ActionType): AppState {
  if (!('recipeId' in action) || !('boxId' in action) || action.recipeId === undefined || action.boxId === undefined) {
    console.warn("Can't change a recipe property without passing recipeId and boxId.")
    return prevState
  }
  const payload = (action as { payload?: unknown }).payload;
  return withRecipe(prevState, action.boxId, action.recipeId, recipe => {
    const base = recipe.changed ?? _.cloneDeep(recipe.data);
    return { ...recipe, changed: { ...base, [key]: payload } };
  });
}

function handleBoxChange(key: string, prevState: AppState, action: ActionType): AppState {
  if (!('boxId' in action) || action.boxId === undefined) {
    console.warn("Can't change a box property without passing boxId.")
    return prevState
  }
  const payload = (action as { payload?: unknown }).payload;
  return withBox(prevState, action.boxId, box => {
    const base = box.changed ?? _.cloneDeep(box.data);
    return { ...box, changed: { ...base, [key]: payload } };
  });
}

export function recipeBoxReducer(prevState: AppState, action: ActionType): AppState {
  switch (action.type) {
    case "INCR_LOADING": {
      return { ...prevState, loading: prevState.loading + 1 }
    }
    case "DECR_LOADING": {
      const newLoading = prevState.loading - 1;
      return {
        ...prevState,
        loading: newLoading,
        // Mark subscriptions as ready once loading completes for the first time
        subscriptionsReady: prevState.subscriptionsReady || newLoading === 0
      }
    }
    case "SET_LOADING": {
      const newLoading = (action as { loading?: number }).loading ?? 0;
      return {
        ...prevState,
        loading: newLoading,
        subscriptionsReady: prevState.subscriptionsReady || newLoading === 0
      }
    }
    case "RESET_STATE": {
      return initState();
    }
    case "ADD_USER": {
      const user = (action as { user?: PlainUser }).user;
      if (user === undefined) {
        console.warn("ADD_USER requires userId and user.")
        return prevState
      }
      return { ...prevState, users: new Map([...prevState.users, [user.id, user]]) }
    }
    case "ADD_RECIPE": {
      const a = action as { boxId?: string; recipeId?: string; payload?: PlainRecipe };
      if (a.boxId === undefined || a.recipeId === undefined) {
        console.warn("ADD_RECIPE requires a boxId and recipeId.")
        return prevState
      }
      const prevBox = prevState.boxes.get(a.boxId)
      if (prevBox === undefined) {
        console.warn(`Attempted to add recipe to non-existent box: ${a.boxId}`)
        return prevState
      }
      if (a.payload === undefined) {
        console.warn("ADD_RECIPE requires a payload.")
        return prevState
      }
      const newRecipes = new Map(prevBox.recipes);
      newRecipes.set(a.recipeId, a.payload);
      const newBox: PlainBox = { ...prevBox, recipes: newRecipes };
      const newBoxes = new Map(prevState.boxes);
      newBoxes.set(a.boxId, newBox);
      return { ...prevState, boxes: newBoxes };
    }
    case "ADD_BOX": {
      const a = action as { boxId?: string; payload?: PlainBox };
      if (a.boxId === undefined) {
        console.warn("ADD_BOX requires a boxId")
        return prevState
      }
      const oldBox = prevState.boxes.get(a.boxId)
      if (a.payload === undefined) {
        console.warn("ADD_BOX requires a payload.")
        return prevState
      }
      // Preserve existing recipes if the incoming payload doesn't have its own.
      const recipes = a.payload.recipes.size
        ? a.payload.recipes
        : (oldBox && oldBox.recipes) || new Map<string, PlainRecipe>();
      const newBox: PlainBox = { ...a.payload, recipes };
      const newBoxes = new Map(prevState.boxes);
      newBoxes.set(a.boxId, newBox);
      return { ...prevState, boxes: newBoxes };
    }
    case "REMOVE_BOX": {
      const a = action as { boxId?: string };
      if (a.boxId === undefined) {
        console.warn("REMOVE_BOX requires a boxId")
        return prevState
      }
      const newBoxes = new Map(prevState.boxes);
      newBoxes.delete(a.boxId);
      return { ...prevState, boxes: newBoxes };
    }
    case "REMOVE_RECIPE": {
      const a = action as { boxId?: string; recipeId?: string };
      if (a.boxId === undefined || a.recipeId === undefined) {
        console.warn("REMOVE_RECIPE requires a boxId and a recipeId")
        return prevState
      }
      const existingBox = prevState.boxes.get(a.boxId)
      if (existingBox === undefined) {
        return prevState
      }
      const newRecipes = new Map(existingBox.recipes);
      newRecipes.delete(a.recipeId);
      const newBox: PlainBox = { ...existingBox, recipes: newRecipes };
      const newBoxes = new Map(prevState.boxes);
      newBoxes.set(a.boxId, newBox);
      return { ...prevState, boxes: newBoxes };
    }
    case "SET_BOX_RECIPES": {
      const a = action as { boxId?: string; payload?: PlainRecipe[] };
      if (a.boxId === undefined || a.payload === undefined) {
        console.warn("SET_BOX_RECIPES requires a boxId and payload.")
        return prevState
      }
      const existingBox = prevState.boxes.get(a.boxId);
      if (existingBox === undefined) {
        // The box hasn't been delivered yet (initial onBox is still
        // pending). Drop this emit — the mirror will redeliver once the
        // box arrives.
        return prevState
      }
      const newRecipes = new Map<string, PlainRecipe>();
      for (const r of a.payload) newRecipes.set(r.id, r);
      const newBox: PlainBox = { ...existingBox, recipes: newRecipes };
      const newBoxes = new Map(prevState.boxes);
      newBoxes.set(a.boxId, newBox);
      return { ...prevState, boxes: newBoxes };
    }
    case "SET_BOXES": {
      const a = action as { payload: Map<string, PlainBox> };
      return { ...prevState, boxes: new Map([...prevState.boxes, ...a.payload]) }
    }
    case "CLEAR_BOXES":
      return { ...prevState, boxes: new Map() }
    case 'SET_READONLY':
      return { ...prevState, writeable: (action as { payload: boolean }).payload }
    case 'SET_RECIPE_NAME': {
      return handleRecipeChange("name", prevState, action)
    }
    case 'SET_INGREDIENTS': {
      return handleRecipeChange("recipeIngredient", prevState, action)
    }
    case 'SET_CATEGORIES': {
      return handleRecipeChange("recipeCategory", prevState, action)
    }
    case 'SET_COMMENT': {
      return handleRecipeChange("comment", prevState, action)
    }
    case 'SET_AUTHOR': {
      return handleRecipeChange("author", prevState, action)
    }
    case 'SET_DESCRIPTION': {
      return handleRecipeChange("description", prevState, action)
    }
    case 'SET_INSTRUCTIONS': {
      return handleRecipeChange("recipeInstructions", prevState, action)
    }
    case 'SET_EDITABLE': {
      const a = action as { recipeId?: string; boxId?: string };
      if (a.recipeId === undefined || a.boxId === undefined) return prevState
      return withRecipe(prevState, a.boxId, a.recipeId, recipe => ({
        ...recipe,
        editing: true,
        changed: _.cloneDeep(recipe.data),
      }));
    }
    case 'RESET_RECIPE': {
      const a = action as { recipeId?: string; boxId?: string };
      if (a.recipeId === undefined || a.boxId === undefined) return prevState
      return withRecipe(prevState, a.boxId, a.recipeId, recipe => ({
        ...recipe,
        editing: false,
        changed: undefined,
      }));
    }
    case 'SET_BOX_NAME': {
      return handleBoxChange("name", prevState, action)
    }
    case 'RESET_BOX': {
      const a = action as { boxId?: string };
      if (a.boxId === undefined) return prevState
      return withBox(prevState, a.boxId, box => ({ ...box, changed: undefined }));
    }
    case 'SET_PENDING_CHANGES': {
      // Optimistically attach AI enrichment/modification results to a recipe
      // so the "Review above" prompt shows up immediately, without waiting on
      // PB realtime to deliver the API-service-side update. Realtime will
      // later confirm with the same value (a no-op overwrite). Pass undefined
      // payload to clear.
      const a = action as { recipeId?: string; boxId?: string; payload?: unknown };
      if (a.recipeId === undefined || a.boxId === undefined) return prevState
      return withRecipe(prevState, a.boxId, a.recipeId, recipe => ({
        ...recipe,
        pendingChanges: a.payload as PlainRecipe['pendingChanges'],
      }));
    }

    default:
      return prevState
  }
}
