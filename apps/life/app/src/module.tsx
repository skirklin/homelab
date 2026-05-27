/**
 * Life tracker route tree. Used by the standalone app entry in App.tsx and by
 * the optional `LifeModule` (kept for parity with other domain packages).
 */
import { useEffect, lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAuth, NotFound } from "@kirkl/shared";
import { LifeProvider, useLifeContext } from "./life-context";
import { BackendProvider, useLifeBackend } from "@kirkl/shared";
import { DisplaySettingsProvider } from "./display-settings";
import { LifeDashboard } from "./components/LifeDashboard";
import { SessionRunner } from "./components/SessionRunner";
import { QuickLog } from "./components/QuickLog";
import { useEntriesSubscription } from "./subscription";

const Visualizations = lazy(() => import("./components/Visualizations").then(m => ({ default: m.Visualizations })));
const Journal = lazy(() => import("./components/Journal").then(m => ({ default: m.Journal })));

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
      const log = await life.getOrCreateLog(user.uid);
      if (cancelled) return;
      dispatch({ type: "SET_LOG", log });
    };

    loadLog();

    return () => { cancelled = true; };
  }, [user?.uid, dispatch, life]);

  // Subscribe to today's events at the route-tree level so every life
  // route (dashboard, /morning, /evening, /weekly, /journal, /insights,
  // /quick) inherits `state.entries` without each having to subscribe on
  // its own. Critical for the push-notification entry path: the "evening
  // session" push lands the user directly on /evening with no dashboard
  // mount, so without this the wizard's `findMorningIntention` lookup ran
  // against an empty `state.entries` and silently dropped the
  // intention_followup prompt (DATA_COLLECTION.md A1).
  useEntriesSubscription(state.log?.id ?? null);

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
        <Route path="/weekly" element={<SessionRunner sessionId="weekly_review" />} />
        <Route path="/quick/:trackableId" element={<QuickLog />} />
        <Route path="/insights" element={
          <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
            <Visualizations />
          </Suspense>
        } />
        <Route path="/journal" element={
          <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
            <Journal />
          </Suspense>
        } />
        <Route path="*" element={<NotFound homePath="/" />} />
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
export type { LogEntry, LifeLog } from "./types";
export type { Trackable } from "./manifest";
