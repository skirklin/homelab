import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ConfigProvider } from "antd";
import styled from "styled-components";
import { useAppContext } from "./context";
import { subscribeToAuth, subscribeToUserSlugs } from "./subscription";
import { Auth } from "./components/Auth";
import { GroceryList } from "./components/GroceryList";
import { ListPicker } from "./components/ListPicker";
import { JoinList } from "./components/JoinList";
import { appStorage } from "./storage";

// Migrate legacy localStorage keys on startup
appStorage.migrateFromLegacy();

const theme = {
  token: {
    colorPrimary: "#2ca6a4",
    borderRadius: 8,
  },
};

const AppWrapper = styled.div`
  max-width: 600px;
  margin: 0 auto;
  min-height: 100vh;
  background: var(--color-bg);
  box-shadow: var(--shadow-md);

  @media (max-width: 600px) {
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
      <Route path="/:slug" element={<GroceryList />} />
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
