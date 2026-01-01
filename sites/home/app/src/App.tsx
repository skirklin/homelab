import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { ConfigProvider, theme } from "antd";
import { AuthProvider, useAuth, initializeBackend } from "@kirkl/shared";
import { GroceriesProvider, GroceriesRoutes } from "@kirkl/groceries";
import { LifeProvider, LifeRoutes } from "@kirkl/life";
import { RecipesProvider, CookingModeProvider, RecipesRoutes } from "@kirkl/recipes";
import { UpkeepProvider, UpkeepRoutes } from "@kirkl/upkeep";
import { Auth } from "./shared/Auth";
import { Shell } from "./shared/Shell";
import { Dashboard } from "./shared/Dashboard";

// Initialize shared backend
initializeBackend("home.kirkl.in");

const LAST_PATH_KEY = "home:lastPath";

// Wrapper that redirects to last used sub-app on initial load
function DashboardWithRestore() {
  const navigate = useNavigate();
  const location = useLocation();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Only redirect on initial mount when at exactly "/"
    if (!checked && location.pathname === "/") {
      const lastPath = localStorage.getItem(LAST_PATH_KEY);
      if (lastPath && lastPath !== "/") {
        navigate(lastPath, { replace: true });
      }
      setChecked(true);
    }
  }, [checked, location.pathname, navigate]);

  return <Dashboard />;
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
        <Route path="/" element={<DashboardWithRestore />} />
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
