/**
 * Shared routes component used by both standalone and embedded modes
 */
import { Routes, Route } from 'react-router-dom';
import { createContext, useContext } from 'react';

import Main from './Main';
import Contents from './routes/Contents';
import Box from './routes/Box';
import Boxes from './routes/Boxes';
import Settings from './routes/Settings';
import RoutedRecipe from './routes/Recipe';
import MissingPage from './routes/MissingPage';
import JoinBox from './routes/JoinBox';

/**
 * Provides the base path for the recipes app so navigate calls work
 * correctly whether standalone (/) or embedded (/recipes/).
 */
const BasePathContext = createContext('/');

export function useBasePath() {
  return useContext(BasePathContext);
}

interface RecipesRoutesProps {
  /** When true, hides sign-out and other account actions (handled by parent shell) */
  embedded?: boolean;
  /** Override the base path for navigation (defaults to '/recipes' if embedded, '' if standalone) */
  basePath?: string;
}

export function RecipesRoutes({ embedded = false, basePath }: RecipesRoutesProps) {
  // In embedded mode the parent mounts us at /recipes, in standalone mode at /
  const resolvedBase = basePath ?? (embedded ? '/recipes' : '');

  return (
    <BasePathContext.Provider value={resolvedBase}>
      <Routes>
        <Route path="/join/:boxId" element={<JoinBox />} />
        <Route path="/" element={<Main embedded={embedded} />}>
          <Route index element={<Contents />} />
          <Route path="settings" element={<Settings />} />
          <Route path="boxes" element={<Boxes />} />
          <Route path="boxes/:boxId" element={<Box />} />
          <Route path="boxes/:boxId/recipes" element={<Box />} />
          <Route path="boxes/:boxId/recipes/:recipeId" element={<RoutedRecipe />} />
          <Route path="*" element={<MissingPage />} />
        </Route>
      </Routes>
    </BasePathContext.Provider>
  );
}
