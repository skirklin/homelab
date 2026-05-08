import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { App as AntApp, ConfigProvider, theme } from "antd";
import { useEffect } from "react";
import { AuthProvider, useAuth, initializeBackend, ErrorBoundary } from "@kirkl/shared";
import { ShoppingProvider, ShoppingRoutes } from "@kirkl/shopping";
import { LifeProvider, LifeRoutes } from "@kirkl/life";
import { RecipesProvider, CookingModeProvider, RecipesRoutes, PublicRecipe } from "@kirkl/recipes";
import { TravelProvider, TravelRoutes } from "@kirkl/travel";
import { UpkeepProvider, UpkeepRoutes, TasksRoutes, isNotificationSupported, requestNotificationPermission, getFcmToken } from "@kirkl/upkeep";
import { Auth } from "./shared/Auth";
import { Shell } from "./shared/Shell";
import { Timeline } from "./shared/Timeline";
import { Settings } from "./shared/Settings";
import { ShoppingIntegrationProvider } from "./shared/ShoppingIntegrationProvider";

// Initialize shared backend
initializeBackend();

const LAST_PATH_KEY = "home:lastPath";
const DEFAULT_APP = "/recipes";

// Redirect to last used sub-app or default
function RedirectToLastApp() {
  const lastPath = localStorage.getItem(LAST_PATH_KEY);
  const target = lastPath && lastPath !== "/" ? lastPath : DEFAULT_APP;
  return <Navigate to={target} replace />;
}

// Invite links work against either the recipes subdomain (standalone) or the
// home app (embedded). When they land at /invite/:code here, forward into the
// recipes module where the redemption UI lives.
function InviteRedirect() {
  const { code } = useParams<{ code: string }>();
  return <Navigate to={`/recipes/invite/${code}`} replace />;
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
        <Route path="/invite/:code" element={<InviteRedirect />} />
        <Route path="/timeline" element={<Timeline />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/life/*" element={<ErrorBoundary label="Life"><LifeRoutes embedded /></ErrorBoundary>} />
        <Route path="/shopping/*" element={<ErrorBoundary label="Shopping"><ShoppingRoutes embedded /></ErrorBoundary>} />
        <Route path="/recipes/*" element={<ErrorBoundary label="Recipes"><RecipesRoutes embedded /></ErrorBoundary>} />
        <Route path="/travel/*" element={<ErrorBoundary label="Travel"><TravelRoutes embedded /></ErrorBoundary>} />
        <Route path="/upkeep/*" element={<ErrorBoundary label="Upkeep"><UpkeepRoutes embedded /></ErrorBoundary>} />
        <Route path="/tasks/*" element={<ErrorBoundary label="Tasks"><TasksRoutes embedded /></ErrorBoundary>} />
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
      <AntApp>
      <BrowserRouter>
        <AuthProvider>
          <ShoppingProvider>
            <LifeProvider>
              <RecipesProvider>
                <CookingModeProvider>
                  <ShoppingIntegrationProvider>
                    <TravelProvider>
                      <UpkeepProvider>
                        <AppRoutes />
                      </UpkeepProvider>
                    </TravelProvider>
                  </ShoppingIntegrationProvider>
                </CookingModeProvider>
              </RecipesProvider>
            </LifeProvider>
          </ShoppingProvider>
        </AuthProvider>
      </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}
