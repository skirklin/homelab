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
import { BackendProvider, useLifeBackend } from "./backend-provider";
import { DisplaySettingsProvider } from "./display-settings";
import type { LifeLog } from "./types";
import { DEFAULT_MANIFEST } from "./types";
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
  const life = useLifeBackend();

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    const loadLog = async () => {
      const backendLog = await life.getOrCreateLog(user.uid);
      if (cancelled) return;
      // Convert backend LifeLog to app LifeLog
      const log: LifeLog = {
        id: backendLog.id,
        name: "",
        owners: [],
        manifest: (backendLog.manifest as unknown as LifeLog["manifest"]) ?? DEFAULT_MANIFEST,
        sampleSchedule: backendLog.sampleSchedule as LifeLog["sampleSchedule"],
        created: new Date(),
        updated: new Date(),
      };
      dispatch({ type: "SET_LOG", log });
    };

    loadLog();

    return () => { cancelled = true; };
  }, [user, dispatch, life]);

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
    <BackendProvider>
      <LifeProvider>
        <LifeRoutes />
      </LifeProvider>
    </BackendProvider>
  );
}

export { LifeProvider, useLife, useLifeContext } from "./life-context";
export type { LogEntry, LifeLog, Widget, LifeManifest } from "./types";
