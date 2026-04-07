import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ConfigProvider } from "antd";
import styled from "styled-components";
import { AuthProvider, useAuth, initializeBackend } from "@kirkl/shared";
import { UpkeepProvider, useUpkeepContext } from "./upkeep-context";
import { subscribeToUserSlugs } from "./subscription";
import { Auth } from "./components/Auth";
import { TaskBoard } from "./components/TaskBoard";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
// Storage is imported to trigger legacy key migration on startup
import "./storage";

// Initialize backend for standalone mode
initializeBackend();

const theme = {
  token: {
    colorPrimary: "#5c7cfa",
    borderRadius: 8,
  },
};

const AppWrapper = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  min-height: 100vh;
  background: var(--color-bg);
  box-shadow: var(--shadow-md);

  @media (max-width: 1200px) {
    box-shadow: none;
  }
`;

function AppContent() {
  const { user, loading } = useAuth();
  const { dispatch } = useUpkeepContext();
  const slugsUnsubRef = useRef<(() => void) | null>(null);

  // Subscribe to user's slugs when authenticated
  useEffect(() => {
    if (user) {
      slugsUnsubRef.current = subscribeToUserSlugs(user.uid, dispatch);
    }
    return () => {
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
    };
  }, [user, dispatch]);

  // Still determining auth state
  if (loading) {
    return null;
  }

  if (!user) {
    return <Auth />;
  }

  return (
    <Routes>
      <Route path="/" element={<ListPicker />} />
      <Route path="/join/:listId" element={<JoinList />} />
      <Route path="/:slug" element={<TaskBoard />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <UpkeepProvider>
        <ConfigProvider theme={theme}>
          <BrowserRouter>
            <AppWrapper>
              <AppContent />
            </AppWrapper>
          </BrowserRouter>
        </ConfigProvider>
      </UpkeepProvider>
    </AuthProvider>
  );
}

export default App;
