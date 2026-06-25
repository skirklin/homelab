/**
 * Life tracker route tree. Used by the standalone app entry in App.tsx and by
 * the optional `LifeModule` (kept for parity with other domain packages).
 */
import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAuth, NotFound, getBackend, useFeedback } from "@kirkl/shared";
import { LifeProvider, useLifeContext } from "./life-context";
import { BackendProvider, useLifeBackend } from "@kirkl/shared";
import { LifeDashboard } from "./components/LifeDashboard";
import { ViewRunner } from "./components/ViewRunner";
import { SettingsModal } from "./components/SettingsModal";
import { SettingsMenuProvider, buildSettingsMenuItems } from "./settings-menu";
import { exportEvents } from "./lib/exportEvents";
import { BottomTabBar, BottomBarSpacer, showsBottomBar } from "./components/BottomTabBar";
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

interface LifeRoutesProps {
  /** When true, hides sign-out and other account actions (handled by parent shell) */
  embedded?: boolean;
}

function LifeRoutesInner({ embedded = false }: LifeRoutesProps) {
  const { user } = useAuth();
  const { state, dispatch } = useLifeContext();
  const life = useLifeBackend();
  const { message } = useFeedback();

  // The Settings modal is mounted ONCE here (not per route) and opened from the
  // shared header-menu fragment every bottom-tab gear pulls via useSettingsMenu.
  const [showSettings, setShowSettings] = useState(false);

  const handleExport = (format: "csv" | "json") => {
    exportEvents(Array.from(state.entries.values()), format);
    message.success(`Exported to ${format.toUpperCase()}`);
  };

  const settingsMenu = useMemo(
    () => ({
      menuItems: buildSettingsMenuItems({
        embedded,
        onOpenSettings: () => setShowSettings(true),
        onSignOut: () => getBackend().authStore.clear(),
      }),
    }),
    [embedded],
  );

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
  // mount, so without this the ViewRunner's templating lookup (the evening
  // intention-follow-up's `{plan}` ref → today's daily_intention) ran against
  // an empty `state.entries` and silently dropped the step (DATA_COLLECTION.md A1).
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

  // Coach master switch (default on). When off, every Coach route — the hub
  // (/coach /insights /observations) and the observation detail thread — is a
  // redirect to "/", so deep links can't land a disabled user on Coach UI.
  const coachEnabled = state.log?.coachEnabled ?? true;
  const coachRoute = coachEnabled ? (
    <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
      <Coach />
    </Suspense>
  ) : (
    <Navigate to="/" replace />
  );

  // Journal switch (default on). Frontend-only: when off, /journal redirects to
  // "/" so deep links can't land a disabled user on the Journal surface.
  const journalEnabled = state.log?.journalEnabled ?? true;
  const journalRoute = journalEnabled ? (
    <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
      <Journal />
    </Suspense>
  ) : (
    <Navigate to="/" replace />
  );

  return (
    <SettingsMenuProvider value={settingsMenu}>
      <Routes>
        <Route path="/" element={<LifeDashboard />} />
        {/* The unified Daily surface lives at "/". /today was the old review
            lens (Timeline · Habits); preserve deep links by redirecting it. */}
        <Route path="/today" element={<Navigate to="/" replace />} />
        <Route path="/morning" element={<ViewRunner viewId="morning" />} />
        <Route path="/evening" element={<ViewRunner viewId="evening" />} />
        <Route path="/weekly" element={<ViewRunner viewId="weekly" />} />
        {/* Coach is the AI hub. /coach, /insights, /observations all render it
            so the Insights/Observations segmented stays consistent and these
            stay deep-linkable. Visualizations/Observations render their content
            inside Coach (inCoach), suppressing their own headers. */}
        <Route path="/coach" element={coachRoute} />
        <Route path="/insights" element={coachRoute} />
        <Route path="/observations" element={coachRoute} />
        <Route path="/journal" element={journalRoute} />
        <Route path="/observations/:id" element={
          coachEnabled ? (
            <Suspense fallback={<LoadingContainer><Spin size="large" /></LoadingContainer>}>
              <ObservationDetail />
            </Suspense>
          ) : (
            <Navigate to="/" replace />
          )
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

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        log={state.log}
        userId={user?.uid}
        onExport={handleExport}
        onResetSchedule={async () => {
          if (state.log?.id) {
            await life.clearSampleSchedule(state.log.id);
          }
        }}
      />
    </SettingsMenuProvider>
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
export type { LogEvent, LifeLog } from "./types";
