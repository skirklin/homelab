import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { LifeDashboard } from "./components/LifeDashboard";
import { useLife } from "./context";
import { getOrCreateUserLog, setCurrentLogId } from "./firestore";
import { logFromStore } from "../../shared/types";

const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

export function LifeModule() {
  const { user } = useAuth();
  const { state, dispatch } = useLife();

  useEffect(() => {
    if (!user) return;

    const loadLog = async () => {
      const { id, data } = await getOrCreateUserLog(user.uid);
      setCurrentLogId(id);
      dispatch({ type: "SET_LOG", log: logFromStore(id, data) });
    };

    loadLog();
  }, [user, dispatch]);

  if (!state.log) {
    return (
      <LoadingContainer>
        <Spin size="large" />
      </LoadingContainer>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<LifeDashboard />} />
      <Route path="*" element={<LifeDashboard />} />
    </Routes>
  );
}
