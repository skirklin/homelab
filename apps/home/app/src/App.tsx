import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ConfigProvider, theme } from "antd";
import { useEffect } from "react";
import { AuthProvider, useAuth, initializeBackend } from "@kirkl/shared";
import { GroceriesProvider, GroceriesRoutes } from "@kirkl/groceries";
import { LifeProvider, LifeRoutes } from "@kirkl/life";
import { RecipesProvider, CookingModeProvider, RecipesRoutes, PublicRecipe } from "@kirkl/recipes";
import { TravelProvider, TravelRoutes } from "@kirkl/travel";
import { UpkeepProvider, UpkeepRoutes, isNotificationSupported, requestNotificationPermission, getFcmToken } from "@kirkl/upkeep";
import { Auth } from "./shared/Auth";
import { Shell } from "./shared/Shell";
import { Timeline } from "./shared/Timeline";
import { Settings } from "./shared/Settings";
import { GroceriesIntegrationProvider } from "./shared/GroceriesIntegrationProvider";

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

function AuthenticatedRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/" element={<RedirectToLastApp />} />
        <Route path="/timeline" element={<Timeline />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/life/*" element={<LifeRoutes embedded />} />
        <Route path="/groceries/*" element={<GroceriesRoutes embedded />} />
        <Route path="/recipes/*" element={<RecipesRoutes embedded />} />
        <Route path="/travel/*" element={<TravelRoutes embedded />} />
        <Route path="/upkeep/*" element={<UpkeepRoutes embedded />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function ProtectedRoute() {
  const { user, loading } = useAuth();

  // Initialize upkeep notifications when user is authenticated
  useEffect(() => {
    if (user && isNotificationSupported()) {
      requestNotificationPermission().then((permission) => {
        if (permission === "granted") {
          getFcmToken(user.uid);
        }
      });
    }
  }, [user]);

  if (loading) {
    return null;
  }

  if (!user) {
    return <Auth />;
  }

  return <AuthenticatedRoutes />;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public routes - accessible without authentication */}
      <Route path="/recipe/:boxId/:recipeId" element={<PublicRecipe />} />

      {/* All other routes require authentication */}
      <Route path="/*" element={<ProtectedRoute />} />
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
                  <GroceriesIntegrationProvider>
                    <TravelProvider>
                      <UpkeepProvider>
                        <AppRoutes />
                      </UpkeepProvider>
                    </TravelProvider>
                  </GroceriesIntegrationProvider>
                </CookingModeProvider>
              </RecipesProvider>
            </LifeProvider>
          </GroceriesProvider>
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
  );
}
