/**
 * Standalone Shopping App
 * Uses shared auth provider and renders the ShoppingModule
 */

import { BrowserRouter } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import styled from "styled-components";
import { initializeBackend, AuthProvider, useAuth } from "@kirkl/shared";

// Initialize PocketBase
initializeBackend();
import { ShoppingModule } from "./module";
import { Auth } from "./components/Auth";

const theme = {
  token: {
    colorPrimary: "#2ca6a4",
    borderRadius: 8,
  },
};

// Standalone host: fills the viewport and paints the page background. The
// 600px column + card shadow live inside <ShoppingList> so the constraint
// follows the module — same shape in embedded mode under the home shell.
const AppWrapper = styled.div`
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--color-bg);
`;

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (!user) {
    return <Auth />;
  }

  return <ShoppingModule />;
}

function App() {
  return (
    <ConfigProvider theme={theme}>
      <AntApp>
      <BrowserRouter>
        <AuthProvider>
          <AppWrapper>
            <AppContent />
          </AppWrapper>
        </AuthProvider>
      </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
