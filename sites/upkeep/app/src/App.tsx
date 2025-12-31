import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ConfigProvider } from "antd";
import styled from "styled-components";
import { useAppContext } from "./context";
import { subscribeToAuth, subscribeToUserSlugs } from "./subscription";
import { Auth } from "./components/Auth";
import { TaskBoard } from "./components/TaskBoard";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
import { requestNotificationPermission, getFcmToken, isNotificationSupported } from "./messaging";
import { appStorage } from "./storage";

// Migrate legacy localStorage keys on startup
appStorage.migrateFromLegacy();

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
  const { state, dispatch } = useAppContext();
  const slugsUnsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToAuth(dispatch);
    return () => unsubscribe();
  }, [dispatch]);

  // Subscribe to user's slugs when authenticated
  useEffect(() => {
    if (state.authUser) {
      slugsUnsubRef.current = subscribeToUserSlugs(state.authUser.uid, dispatch);
    }
    return () => {
      if (slugsUnsubRef.current) {
        slugsUnsubRef.current();
        slugsUnsubRef.current = null;
      }
    };
  }, [state.authUser, dispatch]);

  // Request notification permission when authenticated
  useEffect(() => {
    if (state.authUser && isNotificationSupported()) {
      requestNotificationPermission().then((permission) => {
        if (permission === "granted") {
          getFcmToken(state.authUser!.uid);
        }
      });
    }
  }, [state.authUser]);

  // Still determining auth state
  if (state.authUser === undefined) {
    return null;
  }

  if (!state.authUser) {
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
    <ConfigProvider theme={theme}>
      <BrowserRouter>
        <AppWrapper>
          <AppContent />
        </AppWrapper>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
