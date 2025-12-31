import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ConfigProvider, theme } from "antd";
import { AuthProvider, useAuth, initializeBackend } from "@kirkl/shared";
import { GroceriesModule } from "@kirkl/groceries";
import { RecipesModule } from "@kirkl/recipes";
import { UpkeepModule } from "@kirkl/upkeep";
import { Auth } from "./shared/Auth";
import { Shell } from "./shared/Shell";
import { Dashboard } from "./shared/Dashboard";
import { LifeProvider } from "./modules/life/context";
import { LifeModule } from "./modules/life";

// Initialize shared backend
initializeBackend("home.kirkl.in");

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
        <Route path="/" element={<Dashboard />} />
        <Route
          path="/life/*"
          element={
            <LifeProvider>
              <LifeModule />
            </LifeProvider>
          }
        />
        <Route path="/groceries/*" element={<GroceriesModule />} />
        <Route path="/recipes/*" element={<RecipesModule />} />
        <Route path="/upkeep/*" element={<UpkeepModule />} />
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
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
  );
}
