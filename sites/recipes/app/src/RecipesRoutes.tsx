/**
 * Shared routes component used by both standalone and embedded modes
 */
import { useEffect, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Unsubscribe } from 'firebase/auth';
import { useAuth } from '@kirkl/shared';
import { useRecipesContext } from './context';
import { subscribeToUser, unsubscribe } from './subscription';
import { UnsubMap } from './types';

import Main from './Main';
import Contents from './routes/Contents';
import Box from './routes/Box';
import Boxes from './routes/Boxes';
import Settings from './routes/Settings';
import RoutedRecipe from './routes/Recipe';
import MissingPage from './routes/MissingPage';
import JoinBox from './routes/JoinBox';

export function RecipesRoutes() {
  const { user } = useAuth();
  const { dispatch } = useRecipesContext();
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
  }, [user, dispatch]);

  return (
    <Routes>
      <Route path="/join/:boxId" element={<JoinBox />} />
      <Route path="/" element={<Main />}>
        <Route index element={<Contents />} />
        <Route path="settings" element={<Settings />} />
        <Route path="boxes" element={<Boxes />} />
        <Route path="boxes/:boxId" element={<Box />} />
        <Route path="boxes/:boxId/recipes" element={<Box />} />
        <Route path="boxes/:boxId/recipes/:recipeId" element={<RoutedRecipe />} />
        <Route path="*" element={<MissingPage />} />
      </Route>
    </Routes>
  );
}
