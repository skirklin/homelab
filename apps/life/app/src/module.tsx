/**
 * Life tracker route tree. Used by the standalone app entry in App.tsx and by
 * the optional `LifeModule` (kept for parity with other domain packages).
 */
import { useEffect, lazy, Suspense } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAuth, NotFound } from "@kirkl/shared";
import { LifeProvider, useLifeContext } from "./life-context";
import { BackendProvider, useLifeBackend } from "@kirkl/shared";
import { LifeDashboard } from "./components/LifeDashboard";
import { Today } from "./components/Today";
import { SessionRunner } from "./components/SessionRunner";
import { BottomTabBar, BottomBarSpacer, activeTabForPath } from "./components/BottomTabBar";
import { useEntriesSubscription } from "./subscription";

const Coach = lazy(() => import("./components/Coach").then(m => ({ default: m.Coach })));
const Journal = lazy(() => import("./components/Journal").then(m => ({ default: m.Journal })));
const ObservationDetail = lazy(() => import("./components/ObservationDetail").then(m => ({ default: m.ObservationDetail })));
const Chat = lazy(() => import("./components/Chat").then(m => ({ default: m.Chat })));

const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

/**
 * The bottom tab bar shows on the 4 primary destinations and hides on the
 * focused full-screen flows (session runners, observation detail). We key off
 * `activeTabForPath`: a route that maps to a tab is a primary destination;
 * `/coach` + `/insights` + `/observations` all map to Coach. `/observations/:id`
 * is detail, so it deliberately does NOT match (the prefix check in
 * activeTabForPath only matches `/observations` exactly or `/observations/...`,
 * so we special-case the detail path below).
 */
function showsBottomBar(pathname: string): boolean {
  // Observation DETAIL is a full-screen reply thread — no bar.
  if (pathname.startsWith("/observations/")) return false;
  return activeTabForPath(pathname) !== null;
}

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
  // route (dashboard, /morning, /evening, /weekly, /journal, /insights)
  // inherits `state.entries` without each having to subscribe on
  // its own. Critical for the push-notification entry path: the "evening
  // session" push lands the user directly on /evening with no dashboard
  // mount, so without this the wizard's `findMorningIntention` lookup ran
  // against an empty `state.entries` and silently dropped the
  // intention_followup prompt (DATA_COLLECTION.md A1).
  useEntriesSubscription(state.log?.id ?? null);

  const location = useLocation();
  // Standalone shows the persistent bottom bar on the main destinations; the
  // host shell owns chrome when embedded, so we never render it there.
  const showBar = !embedded && showsBottomBar(location.pathname);

  if (!state.log) {
    return (
      <LoadingContainer>
        <Spin size="large" />
      </LoadingContainer>
    );
  }

  const coachRoute = (
    <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
      <Coach />
    </Suspense>
  );

  return (
    <>
      <Routes>
        <Route path="/" element={<LifeDashboard embedded={embedded} />} />
        <Route path="/today" element={<Today />} />
        <Route path="/morning" element={<SessionRunner sessionId="morning" />} />
        <Route path="/evening" element={<SessionRunner sessionId="evening" />} />
        <Route path="/weekly" element={<SessionRunner sessionId="weekly_review" />} />
        {/* Coach is the AI hub. /coach, /insights, /observations all render it
            so the Insights/Observations segmented stays consistent and these
            stay deep-linkable. Visualizations/Observations render their content
            inside Coach (inCoach), suppressing their own headers. */}
        <Route path="/coach" element={coachRoute} />
        <Route path="/insights" element={coachRoute} />
        <Route path="/observations" element={coachRoute} />
        <Route path="/journal" element={
          <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
            <Journal />
          </Suspense>
        } />
        <Route path="/observations/:id" element={
          <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
            <ObservationDetail />
          </Suspense>
        } />
        {/* /chat is intentionally unlinked from nav (no tab, no menu item, no
            badge) — reachable only by direct URL. Kept as a PM/product-iteration
            meta channel. */}
        <Route path="/chat" element={
          <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
            <Chat />
          </Suspense>
        } />
        <Route path="*" element={<NotFound homePath="/" />} />
      </Routes>
      {showBar && (
        <>
          <BottomBarSpacer />
          <BottomTabBar />
        </>
      )}
    </>
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
