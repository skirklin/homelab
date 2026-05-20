/**
 * Life tracker route tree. Used by the standalone app entry in App.tsx and by
 * the optional `LifeModule` (kept for parity with other domain packages).
 */
import { useEffect, lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAuth } from "@kirkl/shared";
import { LifeProvider, useLifeContext } from "./life-context";
import { BackendProvider, useLifeBackend } from "@kirkl/shared";
import { DisplaySettingsProvider } from "./display-settings";
import { LifeDashboard } from "./components/LifeDashboard";
import { SessionRunner } from "./components/SessionRunner";
import type { LifeLog } from "./types";

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
  const { state, dispatch } = useLifeContext();
  const life = useLifeBackend();

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    const loadLog = async () => {
      const backendLog = await life.getOrCreateLog(user.uid);
      if (cancelled) return;
      const log: LifeLog = {
        id: backendLog.id,
        sampleSchedule: backendLog.sampleSchedule as LifeLog["sampleSchedule"],
        morningReminderTime: backendLog.morningReminderTime ?? null,
        eveningReminderTime: backendLog.eveningReminderTime ?? null,
      };
      dispatch({ type: "SET_LOG", log });
    };

    loadLog();

    return () => { cancelled = true; };
  }, [user?.uid, dispatch, life]);

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
        <Route path="/morning" element={<SessionRunner sessionId="morning" />} />
        <Route path="/evening" element={<SessionRunner sessionId="evening" />} />
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

export { LifeProvider, useLifeContext } from "./life-context";
export type { LogEntry, LifeLog, Widget, LifeManifest } from "./types";
