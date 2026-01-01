import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ConfigProvider, theme } from "antd";
import { AuthProvider, useAuth, initializeBackend } from "@kirkl/shared";
import { GroceriesProvider, GroceriesRoutes } from "@kirkl/groceries";
import { LifeProvider, LifeRoutes } from "@kirkl/life";
import { RecipesProvider, CookingModeProvider, RecipesRoutes } from "@kirkl/recipes";
import { UpkeepProvider, UpkeepRoutes } from "@kirkl/upkeep";
import { Auth } from "./shared/Auth";
import { Shell } from "./shared/Shell";

// Initialize shared backend
initializeBackend("home.kirkl.in");

const LAST_PATH_KEY = "home:lastPath";
const DEFAULT_APP = "/recipes";

// Redirect to last used sub-app or default
function RedirectToLastApp() {
  const lastPath = localStorage.getItem(LAST_PATH_KEY);
  const target = lastPath && lastPath !== "/" ? lastPath : DEFAULT_APP;
  return <Navigate to={target} replace />;
}

const antTheme = {
  token: {
    colorPrimary: "#7c3aed",
    borderRadius: 6,
  },
  algorithm: theme.defaultAlgorithm,
};

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return null;
  }

  if (!user) {
    return <Auth />;
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<RedirectToLastApp />} />
        <Route path="/life/*" element={<LifeRoutes />} />
        <Route path="/groceries/*" element={<GroceriesRoutes />} />
        <Route path="/recipes/*" element={<RecipesRoutes />} />
        <Route path="/upkeep/*" element={<UpkeepRoutes />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <ConfigProvider theme={antTheme}>
      <BrowserRouter>
        <AuthProvider>
          <GroceriesProvider>
            <LifeProvider>
              <RecipesProvider>
                <CookingModeProvider>
                  <UpkeepProvider>
                    <AppRoutes />
                  </UpkeepProvider>
                </CookingModeProvider>
              </RecipesProvider>
            </LifeProvider>
          </GroceriesProvider>
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
  );
}
