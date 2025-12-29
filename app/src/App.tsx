import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ConfigProvider } from "antd";
import styled from "styled-components";
import { useAppContext } from "./context";
import { subscribeToAuth, loadUserLists } from "./subscription";
import { Auth } from "./components/Auth";
import { GroceryList } from "./components/GroceryList";

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

  useEffect(() => {
    const unsubscribe = subscribeToAuth(dispatch);
    return () => unsubscribe();
  }, [dispatch]);

  // Load user's lists when authenticated
  useEffect(() => {
    if (state.authUser) {
      loadUserLists(state.authUser.uid, dispatch);
    }
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
      <Route path="/" element={<GroceryList />} />
      <Route path="/:listId" element={<GroceryList />} />
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
