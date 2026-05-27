import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation, useNavigate, Link } from "react-router-dom";
import { App as AntApp, ConfigProvider, theme } from "antd";
import { useEffect, useState } from "react";
import { AuthProvider, BackendProvider, useAuth, initializeBackend, ErrorBoundary, getInviteInfo } from "@kirkl/shared";
import { ShoppingProvider, ShoppingRoutes } from "@kirkl/shopping";
import { RecipesProvider, CookingModeProvider, RecipesRoutes, PublicRecipe } from "@kirkl/recipes";
import { TravelProvider, TravelRoutes } from "@kirkl/travel";
import { UpkeepProvider, UpkeepRoutes, TasksRoutes, isNotificationSupported, requestNotificationPermission, getFcmToken } from "@kirkl/upkeep";
import { Auth } from "./shared/Auth";
import { Shell, MODULE_ROOTS, isModulePath } from "./shared/Shell";
import { Timeline } from "./shared/Timeline";
import { Settings } from "./shared/Settings";
import { ShoppingIntegrationProvider } from "./shared/ShoppingIntegrationProvider";

// Initialize shared backend
initializeBackend();

const LAST_PATH_KEY = "home:lastPath";
const DEFAULT_APP = "/recipes";

// Redirect to last used sub-app or default. The stored value is validated
// against MODULE_ROOTS so a stale entry from a removed module (e.g. /life/...
// after the May 20 extraction) or malformed input falls back to DEFAULT_APP
// instead of cold-launching into a dead route.
function RedirectToLastApp() {
  let target = DEFAULT_APP;
  try {
    const lastPath = localStorage.getItem(LAST_PATH_KEY);
    if (lastPath && lastPath !== "/" && isModulePath(lastPath)) {
      target = lastPath;
    }
  } catch {
    // localStorage unavailable (private mode / SSR) — DEFAULT_APP is fine.
  }
  return <Navigate to={target} replace />;
}

// Re-export so other call sites can stay in lockstep with the shell.
export { MODULE_ROOTS };

// Invite links work against either the per-app subdomains (standalone) or
// the home app (embedded). When they land at /invite/:code here, look up the
// invite's target_type and forward into the module that owns the redemption
// UI. Falls back to /recipes/invite/:code for unknown codes — recipes was
// the only invite type when this redirect was first written, and that path's
// own error UI handles "invalid invite" cleanly.
function InviteRedirect() {
  const { code } = useParams<{ code: string }>();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!code) {
      setTarget("/recipes");
      return;
    }
    getInviteInfo(code)
      .then((info) => {
        if (cancelled) return;
        const mod = info?.target_module || "recipes";
        setTarget(`/${mod}/invite/${code}`);
      })
      .catch(() => {
        if (cancelled) return;
        setTarget(`/recipes/invite/${code}`);
      });
    return () => { cancelled = true; };
  }, [code]);

  if (!target) return null;
  return <Navigate to={target} replace />;
}

// Rendered when no route matches. Replaces the previous silent
// `<Navigate to="/" replace />` catch-all, which swallowed real routing
// bugs by bouncing typos and stale links back to the user's last module.
function NotFound() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div style={{
      margin: "40px auto",
      maxWidth: 480,
      padding: 24,
      borderRadius: 8,
      boxShadow: "0 4px 12px 0 rgba(0, 0, 0, 0.15)",
      background: "white",
      textAlign: "center",
    }}>
      <h1 style={{ color: "var(--color-primary)", marginBottom: 8 }}>Page not found</h1>
      <p style={{ marginBottom: 16, color: "var(--color-text-subtle, #666)" }}>
        No route matches <code>{location.pathname}</code>.
      </p>
      <button
        type="button"
        onClick={() => navigate("/", { replace: true })}
        style={{
          padding: "8px 16px",
          border: "none",
          borderRadius: 6,
          background: "var(--color-primary)",
          color: "white",
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 500,
          minHeight: 44,
        }}
      >
        Go home
      </button>
      <div style={{ marginTop: 16, fontSize: 13, color: "var(--color-text-subtle, #666)" }}>
        Or jump to{" "}
        <Link to="/recipes">Recipes</Link>{", "}
        <Link to="/shopping">Shopping</Link>{", "}
        <Link to="/upkeep">Upkeep</Link>{", "}
        <Link to="/travel">Travel</Link>{", "}
        <Link to="/tasks">Tasks</Link>.
      </div>
    </div>
  );
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
        <Route path="/shopping/*" element={<ErrorBoundary label="Shopping"><ShoppingRoutes embedded /></ErrorBoundary>} />
        <Route path="/recipes/*" element={<ErrorBoundary label="Recipes"><RecipesRoutes embedded /></ErrorBoundary>} />
        <Route path="/travel/*" element={<ErrorBoundary label="Travel"><TravelRoutes embedded /></ErrorBoundary>} />
        <Route path="/upkeep/*" element={<ErrorBoundary label="Upkeep"><UpkeepRoutes embedded /></ErrorBoundary>} />
        <Route path="/tasks/*" element={<ErrorBoundary label="Tasks"><TasksRoutes embedded /></ErrorBoundary>} />
      </Route>
      <Route path="*" element={<NotFound />} />
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
          <BackendProvider>
            <ShoppingProvider>
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
            </ShoppingProvider>
          </BackendProvider>
        </AuthProvider>
      </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}
