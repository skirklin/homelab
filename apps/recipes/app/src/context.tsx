import { createContext, useContext, useReducer, useEffect, useRef, type ReactNode } from 'react';
import { useAuth } from '@kirkl/shared';
import type { ActionType, AppState, UnsubMap } from './types';
import { initState, recipeBoxReducer } from './reducer';
import { subscribeToUser, unsubscribe } from './subscription';

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
  const unsubMapRef = useRef<UnsubMap | null>(null);

  useEffect(() => {
    if (!user) {
      dispatch({ type: 'RESET_STATE' });
      return;
    }

    let cancelled = false;
    const unsubMap: UnsubMap = {
      userUnsub: undefined,
      boxesUnsub: undefined,
      boxMap: new Map<string, {
        boxUnsub: (() => void) | undefined,
        recipesUnsub: (() => void) | undefined,
      }>(),
    };
    unsubMapRef.current = unsubMap;

    subscribeToUser(user, dispatch, unsubMap, () => cancelled).finally(() => {
      // Guard against StrictMode double-mount: only clear loading if this
      // effect instance hasn't been cleaned up
      if (!cancelled) {
        dispatch({ type: "SET_LOADING", loading: 0 });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe(unsubMap);
      unsubMapRef.current = null;
    };
  }, [user]);

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
