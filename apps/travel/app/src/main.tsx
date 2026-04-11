import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider } from "antd";
import { AuthProvider, useAuth, LoginScreen } from "@kirkl/shared";
import { TravelModule } from "./module";

import { initializeBackend } from "@kirkl/shared";
initializeBackend();

function App() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <LoginScreen title="Travel" />;
  return <TravelModule />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
  </StrictMode>
);
