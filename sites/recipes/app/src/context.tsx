import { createContext, useContext, useReducer, type ReactNode } from 'react';
import { ActionType, AppState } from './types';
import { initState, recipeBoxReducer } from './reducer';

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
