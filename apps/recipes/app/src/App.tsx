import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider, initializeBackend, BackendProvider, ScrollRestoration } from '@kirkl/shared';
import { RecipesProvider } from './context';
import { CookingModeProvider } from './CookingModeContext';
import Auth from './Auth';
import { RecipesRoutes } from './RecipesRoutes';

// Initialize backend for standalone mode (PocketBase)
initializeBackend();

function App() {
  return (
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
  );
}

export default App;
