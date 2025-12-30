import _ from 'lodash';
import { BoxEntry, RecipeEntry, UserEntry } from './storage';
import { ActionType, AppState } from './types';
import { getBoxFromState, getRecipeFromState, setBoxInState, setRecipeInState } from './state';

export function initState(): AppState {
  return (
    {
      boxes: new Map<string, BoxEntry>(),
      writeable: true,
      users: new Map<string, UserEntry>(),
      authUser: null,
      loading: 0,
      subscriptionsReady: false,
    }
  )
}

function handleRecipeChange(key: string, prevState: AppState, action: ActionType) {
  if (action.recipeId === undefined || action.boxId === undefined) {
    console.warn("Can't change a recipe property without passing recipeId and boxId.")
    return prevState
  }
  const recipe = getRecipeFromState(prevState, action.boxId, action.recipeId)
  if (recipe === undefined) {
    return prevState
  }

  const newState = { ...prevState }
  if (recipe.changed === undefined) {
    recipe.changed = _.cloneDeep(recipe.data)
  }
  recipe.changed = { ...(recipe.changed), [key]: action.payload }
  return newState
}


function handleBoxChange(key: string, prevState: AppState, action: ActionType) {
  if (action.boxId === undefined) {
    console.warn("Can't change a box property without passing boxId.")
    return prevState
  }
  const box = getBoxFromState(prevState, action.boxId)
  if (box === undefined) {
    return prevState
  }

  const newState = { ...prevState }
  if (box.changed === undefined) {
    box.changed = _.cloneDeep(box.data)
  }
  box.changed = { ...(box.changed), [key]: action.payload }
  return newState
}

export function recipeBoxReducer(prevState: AppState, action: ActionType): AppState {
  let newBox: BoxEntry, state: AppState
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
    case "SET_AUTH_USER": {
      const authUser = action.authUser
      if (authUser === undefined) {
        console.warn("SET_AUTH_USER requires userId and user.")
        return prevState
      }
      if (authUser !== prevState.authUser) {
        return { ...initState(), authUser }
      } else {
        return prevState
      }
    }
    case "ADD_USER": {
      const user = action.user
      if (user === undefined) {
        console.warn("ADD_USER requires userId and user.")
        return prevState
      }

      state = { ...prevState, users: new Map([...prevState.users, [user.id, user]]) }
      return state
    }
    case "ADD_RECIPE": {
      if (action.boxId === undefined || (action.recipeId === undefined)) {
        console.warn("ADD_RECIPE requires a boxId and recipeId.")
        return prevState
      }
      const prevBox = prevState.boxes.get(action.boxId)
      if (prevBox === undefined) {
        console.warn(`Attempted to add recipe to non-existent box: ${action.boxId}`)
        return prevState
      }
      const box = prevBox.clone()
      if (action.payload === undefined) {
        console.warn("ADD_RECIPE requires a payload.")
        return prevState
      }
      box.recipes = new Map([...box.recipes, [action.recipeId, action.payload as RecipeEntry]])
      state = { ...prevState, boxes: new Map([...prevState.boxes, [action.boxId, box]]) }
      return state
    }
    case "ADD_BOX": {
      if (action.boxId === undefined) {
        console.warn("ADD_BOX requires a boxId")
        return prevState
      }
      const oldBox = prevState.boxes.get(action.boxId)
      if (action.payload === undefined) {
        console.warn("ADD_BOX requires a payload.")
        return prevState
      }
      newBox = _.cloneDeep(action.payload as BoxEntry)
      newBox.recipes = newBox.recipes.size ? newBox.recipes : (oldBox && oldBox.recipes) || new Map<string, RecipeEntry>()
      state = { ...prevState, boxes: new Map([...prevState.boxes, [action.boxId, newBox]]) }
      return state
    }
    case "REMOVE_BOX": {
      if (action.boxId === undefined) {
        console.warn("REMOVE_BOX requires a boxId")
        return prevState
      }
      state = { ...prevState, boxes: new Map(prevState.boxes) }
      state.boxes.delete(action.boxId)
      return state
    }
    case "REMOVE_RECIPE": {
      if (action.boxId === undefined || action.recipeId === undefined) {
        console.warn("REMOVE_RECIPE requires a boxId and a recipeId")
        return prevState
      }
      const existingBox = prevState.boxes.get(action.boxId)
      if (existingBox === undefined) {
        return prevState
      }
      const updatedBox = existingBox.clone()
      updatedBox.recipes = new Map(existingBox.recipes)
      updatedBox.recipes.delete(action.recipeId)
      return { ...prevState, boxes: new Map([...prevState.boxes, [action.boxId, updatedBox]]) }
    }
    case "SET_BOXES": {
      return { ...prevState, boxes: new Map([...prevState.boxes, ...action.payload as Map<string, BoxEntry>]) }
    }
    case "CLEAR_BOXES":
      return { ...prevState, boxes: new Map() }
    case 'SET_READONLY':
      return { ...prevState, writeable: action.payload as boolean }
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
      if (action.recipeId === undefined || action.boxId === undefined) return prevState

      const newState = { ...prevState }
      const recipe = getRecipeFromState(prevState, action.boxId, action.recipeId)
      if (recipe === undefined) return prevState
      recipe.editing = true;
      recipe.changed = _.cloneDeep(recipe.data)
      setRecipeInState(newState, action.boxId, action.recipeId, recipe)
      return newState
    }
    case 'RESET_RECIPE': {
      if (action.recipeId === undefined || action.boxId === undefined) return prevState
      const recipe = getRecipeFromState(prevState, action.boxId, action.recipeId)
      if (recipe === undefined) return prevState
      const newState = { ...prevState }
      recipe.changed = undefined
      recipe.editing = false
      setRecipeInState(newState, action.boxId, action.recipeId, recipe)
      return newState
    }
    case 'SET_BOX_NAME': {
      return handleBoxChange("name", prevState, action)
    }
    case 'RESET_BOX': {
      if (action.boxId === undefined) return prevState
      const box = getBoxFromState(prevState, action.boxId)
      if (box === undefined) return prevState
      const newState = { ...prevState }
      if (box.changed !== undefined) {
        box.changed = undefined
      }
      setBoxInState(newState, action.boxId, box)
      return newState
    }

    default:
      return prevState
  }
}
