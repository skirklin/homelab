import { createContext, useContext, useReducer, useEffect, useRef, type ReactNode } from 'react';
import type { Unsubscribe } from 'firebase/auth';
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

    const unsubMap: UnsubMap = {
      userUnsub: undefined,
      boxesUnsub: undefined,
      boxMap: new Map<string, {
        boxUnsub: Unsubscribe,
        recipesUnsub: Unsubscribe
      }>(),
    };
    unsubMapRef.current = unsubMap;

    subscribeToUser(user, dispatch, unsubMap);

    return () => {
      console.debug('Unsubscribing from all.');
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
