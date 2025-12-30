import React, { useReducer } from 'react';
import { recipeBoxReducer, initState, Context } from './context';
import { AppState, ActionType } from './types';
import Router from './Router';


function App() {
  const [state, dispatch] = useReducer<React.Reducer<AppState, ActionType>>(recipeBoxReducer, initState())

  return (
    <Context.Provider value={{ state, dispatch }}>
      <Router />
    </Context.Provider>
  )
}

export default App