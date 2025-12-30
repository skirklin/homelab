import { createContext } from 'react';
import { BoxEntry, UserEntry } from './storage';
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

// Re-export reducer and initState for convenience
export { initState, recipeBoxReducer } from './reducer';
