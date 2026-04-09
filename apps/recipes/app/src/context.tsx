import { createContext, useContext, useReducer, useEffect, type ReactNode } from 'react';
import { useAuth } from '@kirkl/shared';
import type { ActionType, AppState } from './types';
import { initState, recipeBoxReducer } from './reducer';
import { useRecipesBackend } from './backend-provider';
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
        for (const r of boxRecipes) {
          const recipeEntry = recipeFromBackend(r);
          dispatch({ type: "ADD_RECIPE", recipeId: r.id, boxId: box.id, payload: recipeEntry });
        }
      },
      onBoxRemoved: (boxId) => {
        dispatch({ type: "REMOVE_BOX", boxId });
      },
      onRecipeChanged: (boxId, r) => {
        const recipeEntry = recipeFromBackend(r);
        dispatch({ type: "ADD_RECIPE", recipeId: r.id, boxId, payload: recipeEntry });
      },
      onRecipeRemoved: (boxId, recipeId) => {
        dispatch({ type: "REMOVE_RECIPE", boxId, recipeId });
      },
    });

    return () => {
      unsub();
    };
  }, [user, recipes]);

  return (
    <Context.Provider value={{ state, dispatch }}>
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
