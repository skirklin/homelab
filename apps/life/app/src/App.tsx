import { BrowserRouter } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import { AuthProvider, BackendProvider, useAuth, initializeBackend, ErrorBoundary, ScrollRestoration } from "@kirkl/shared";
import { LifeProvider } from "./life-context";
import { LifeRoutes } from "./module";
import { Auth } from "./components/Auth";

initializeBackend();

const theme = {
  token: {
    colorPrimary: "#13c2c2",
    borderRadius: 8,
  },
};

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) return null;
  // Auth gate sits inside BrowserRouter and intentionally does NOT navigate
  // on sign-in. The router's location is preserved while <Auth /> is shown,
  // so a cold-launched PWA deep link like /quick/sleep?v=480 survives the
  // gate and resumes at the original URL once `user` flips truthy.
  if (!user) return <Auth />;

  return (
    <ErrorBoundary label="Life">
      <LifeRoutes />
    </ErrorBoundary>
  );
}

function App() {
  return (
    <ConfigProvider theme={theme}>
      <AntApp>
        <BrowserRouter>
          <ScrollRestoration />
          <AuthProvider>
            <BackendProvider>
              <LifeProvider>
                <AppContent />
              </LifeProvider>
            </BackendProvider>
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
