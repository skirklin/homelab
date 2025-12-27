import { useEffect } from "react";
import { ConfigProvider } from "antd";
import { useAppContext } from "./context";
import { subscribeToAuth } from "./subscription";
import { Auth } from "./components/Auth";
import { GroceryList } from "./components/GroceryList";

const theme = {
  token: {
    colorPrimary: "#2ca6a4",
    borderRadius: 8,
  },
};

function App() {
  const { state, dispatch } = useAppContext();

  useEffect(() => {
    const unsubscribe = subscribeToAuth(dispatch);
    return () => unsubscribe();
  }, [dispatch]);

  // Still determining auth state
  if (state.authUser === undefined) {
    return null;
  }

  return (
    <ConfigProvider theme={theme}>
      {state.authUser ? <GroceryList /> : <Auth />}
    </ConfigProvider>
  );
}

export default App;
