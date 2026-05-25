import { createContext, useContext, useReducer, useEffect, useMemo, type ReactNode } from 'react';
import { useAuth } from '@kirkl/shared';
import type { Recipe as BackendRecipe } from '@homelab/backend';
import type { ActionType, AppState } from './types';
import { initState, recipeBoxReducer } from './reducer';
import { useRecipesBackend } from '@kirkl/shared';
import { boxFromBackend, recipeFromBackend, userFromBackend } from './adapters';

export type ContextType = {
  state: AppState
  dispatch: React.Dispatch<ActionType>
}

const initialState = initState()
const defaultDispatch: React.Dispatch<ActionType> = () => initialState

export const Context = createContext<ContextType>(
  {
    state: initialState,
    dispatch: defaultDispatch,
  }
)

export function RecipesProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(recipeBoxReducer, initState());
  const { user } = useAuth();
  const recipes = useRecipesBackend();

  useEffect(() => {
    if (!user) {
      dispatch({ type: 'RESET_STATE' });
      return;
    }

    let initialLoad = true;

    const dispatchRecipesForBox = (boxId: string, boxRecipes: BackendRecipe[]) => {
      // Replace the whole recipes Map for this box. Matches the mirror's
      // per-slice full-state delivery: every emit is the authoritative set.
      const entries = boxRecipes.map(recipeFromBackend);
      dispatch({ type: "SET_BOX_RECIPES", boxId, payload: entries });
    };

    const unsub = recipes.subscribeToUser(user.uid, {
      onUser: (u) => {
        const userEntry = userFromBackend(u);
        dispatch({ type: "ADD_USER", user: userEntry });
        if (initialLoad) {
          initialLoad = false;
          dispatch({ type: "SET_LOADING", loading: 0 });
        }
      },
      onBox: (box, boxRecipes) => {
        const boxEntry = boxFromBackend(box);
        dispatch({ type: "ADD_BOX", boxId: box.id, payload: boxEntry });
        dispatchRecipesForBox(box.id, boxRecipes);
      },
      onBoxRemoved: (boxId) => {
        dispatch({ type: "REMOVE_BOX", boxId });
      },
      onRecipes: (boxId, boxRecipes) => {
        dispatchRecipesForBox(boxId, boxRecipes);
      },
    });

    return () => {
      unsub();
    };
  }, [user?.uid, recipes]);

  // Memoize the provider value so consumers don't re-render on every
  // RecipesProvider render — only when state actually changes. dispatch
  // is reducer-stable, so it doesn't need to be in deps.
  const contextValue = useMemo(() => ({ state, dispatch }), [state]);

  return (
    <Context.Provider value={contextValue}>
      {children}
    </Context.Provider>
  );
}

export function useRecipesContext() {
  const context = useContext(Context);
  if (!context) {
    throw new Error("useRecipesContext must be used within RecipesProvider");
  }
  return context;
}

// Re-export reducer and initState for convenience
export { initState, recipeBoxReducer } from './reducer';
