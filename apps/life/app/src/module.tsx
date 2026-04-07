/**
 * Life tracker module for embedding in the home app.
 * Provides routes that can be mounted at /life/*
 */
import { useEffect, lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { LifeProvider, useLife } from "./life-context";
import { DisplaySettingsProvider } from "./display-settings";
import { getOrCreateUserLog, setCurrentLogId, getCachedLogId } from "./pocketbase";
import { logFromStore } from "./types";
import { LifeDashboard } from "./components/LifeDashboard";

// Lazy load heavy visualization component
const Visualizations = lazy(() => import("./components/Visualizations").then(m => ({ default: m.Visualizations })));

const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

interface LifeRoutesProps {
  /** When true, hides sign-out and other account actions (handled by parent shell) */
  embedded?: boolean;
}

function LifeRoutesInner({ embedded = false }: LifeRoutesProps) {
  const { user } = useAuth();
  const { state, dispatch } = useLife();

  useEffect(() => {
    if (!user) return;

    // Try to use cached log ID for immediate subscription start
    const cachedLogId = getCachedLogId();
    if (cachedLogId) {
      setCurrentLogId(cachedLogId);
    }

    let cancelled = false;
    const loadLog = async () => {
      const { id, data } = await getOrCreateUserLog(user.uid);
      if (cancelled) return;
      setCurrentLogId(id);
      dispatch({ type: "SET_LOG", log: logFromStore(id, data) });
    };

    loadLog();

    return () => { cancelled = true; };
  }, [user, dispatch]);

  if (!state.log) {
    return (
      <LoadingContainer>
        <Spin size="large" />
      </LoadingContainer>
    );
  }

  return (
    <DisplaySettingsProvider>
      <Routes>
        <Route path="/" element={<LifeDashboard embedded={embedded} />} />
        <Route path="/insights" element={
          <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
            <Visualizations />
          </Suspense>
        } />
        <Route path="*" element={<LifeDashboard embedded={embedded} />} />
      </Routes>
    </DisplaySettingsProvider>
  );
}

export function LifeRoutes({ embedded = false }: LifeRoutesProps) {
  const { user } = useAuth();

  if (!user) return null;

  return <LifeRoutesInner embedded={embedded} />;
}

export function LifeModule() {
  return (
    <LifeProvider>
      <LifeRoutes />
    </LifeProvider>
  );
}

export { LifeProvider, useLife, useLifeContext } from "./life-context";
export type { LogEntry, LifeLog, Widget, LifeManifest } from "./types";
