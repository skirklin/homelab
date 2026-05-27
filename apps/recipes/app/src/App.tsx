import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { AuthProvider, initializeBackend, BackendProvider, ScrollRestoration } from '@kirkl/shared';
import { RecipesProvider } from './context';
import { CookingModeProvider } from './CookingModeContext';
import Auth from './Auth';
import { RecipesRoutes } from './RecipesRoutes';

// Initialize backend for standalone mode (PocketBase)
initializeBackend();

function App() {
  // <AntApp> provides the hook-based feedback API (App.useApp() → useFeedback).
  // Without it, components calling `useFeedback().message.*` crash at render
  // time with "message.success is not a function" — silently fatal for
  // InviteRedeem, NewBoxModal, and every other touch-point that surfaces a
  // toast. The home app wraps the same way; standalone parity matters because
  // recipes.kirkl.in serves this build directly.
  return (
    <AntApp>
      <AuthProvider>
        <BackendProvider>
          <RecipesProvider>
            <CookingModeProvider>
              <Auth>
                <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                  <ScrollRestoration />
                  <RecipesRoutes />
                </BrowserRouter>
              </Auth>
            </CookingModeProvider>
          </RecipesProvider>
        </BackendProvider>
      </AuthProvider>
    </AntApp>
  );
}

export default App;
