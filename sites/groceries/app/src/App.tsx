/**
 * Standalone Groceries App
 * Uses shared auth provider and renders the GroceriesModule
 */

import { BrowserRouter } from "react-router-dom";
import { ConfigProvider } from "antd";
import styled from "styled-components";
import { AuthProvider, useAuth } from "@kirkl/shared";
import { GroceriesModule } from "./module";
import { Auth } from "./components/Auth";

const theme = {
  token: {
    colorPrimary: "#2ca6a4",
    borderRadius: 8,
  },
};

const AppWrapper = styled.div`
  max-width: 600px;
  margin: 0 auto;
  min-height: 100vh;
  background: var(--color-bg);
  box-shadow: var(--shadow-md);

  @media (max-width: 600px) {
    box-shadow: none;
  }
`;

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (!user) {
    return <Auth />;
  }

  return <GroceriesModule />;
}

function App() {
  return (
    <ConfigProvider theme={theme}>
      <BrowserRouter>
        <AuthProvider>
          <AppWrapper>
            <AppContent />
          </AppWrapper>
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
