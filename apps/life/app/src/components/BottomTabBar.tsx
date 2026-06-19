/**
 * BottomTabBar — persistent mobile-first navigation across the life app's 4
 * primary destinations. Standalone only: the host shell owns chrome when
 * `embedded`, so this isn't rendered there (see module.tsx).
 *
 * Active tab is derived from the current pathname, not click state, so deep
 * links and back/forward highlight correctly. Coach owns several sub-routes
 * (/coach, /insights, /observations, /observations/:id) so they all light up
 * the Coach tab.
 */
import { useLocation, useNavigate } from "react-router-dom";
import styled from "styled-components";
import {
  EditOutlined,
  CalendarOutlined,
  BookOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import { useLifeContext } from "../life-context";

export type LifeTab = "log" | "today" | "journal" | "coach";

interface TabDef {
  tab: LifeTab;
  label: string;
  icon: ReactNode;
  path: string;
}

const TABS: TabDef[] = [
  { tab: "log", label: "Log", icon: <EditOutlined />, path: "/" },
  { tab: "today", label: "Today", icon: <CalendarOutlined />, path: "/today" },
  { tab: "journal", label: "Journal", icon: <BookOutlined />, path: "/journal" },
  { tab: "coach", label: "Coach", icon: <RobotOutlined />, path: "/coach" },
];

/**
 * Which tab owns a given pathname. Coach is the hub for the AI/analysis
 * surfaces, so its sub-routes resolve to Coach. Anything unrecognized falls
 * through to null (no tab highlighted) rather than guessing.
 */
export function activeTabForPath(pathname: string): LifeTab | null {
  if (pathname === "/" ) return "log";
  if (pathname === "/today" || pathname.startsWith("/today/")) return "today";
  if (pathname === "/journal" || pathname.startsWith("/journal/")) return "journal";
  if (
    pathname === "/coach" ||
    pathname.startsWith("/coach/") ||
    pathname === "/insights" ||
    pathname.startsWith("/insights/") ||
    pathname === "/observations" ||
    pathname.startsWith("/observations/")
  ) {
    return "coach";
  }
  return null;
}

/**
 * Whether the bottom bar shows for a pathname. It shows on the 4 primary
 * destinations (anything `activeTabForPath` recognizes) and hides on the
 * focused full-screen flows: session runners (/morning, /evening, /weekly) and
 * the observation DETAIL reply thread (/observations/:id). The detail path is
 * special-cased because it maps to the Coach tab for highlighting purposes but
 * is still a full-screen flow.
 */
export function showsBottomBar(pathname: string): boolean {
  if (pathname.startsWith("/observations/")) return false;
  return activeTabForPath(pathname) !== null;
}

const Bar = styled.nav`
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 100;
  display: flex;
  background: var(--color-bg);
  border-top: 1px solid var(--color-border);
  /* Lift the touch targets above the iOS home indicator. */
  padding-bottom: env(safe-area-inset-bottom);
`;

const TabButton = styled.button<{ $active: boolean }>`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 44px;
  padding: 6px 0 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: ${(p) => (p.$active ? "var(--color-primary)" : "var(--color-text-secondary)")};
  font-size: var(--font-size-xs);
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  transition: color 0.15s;

  .anticon {
    font-size: 20px;
  }

  &:hover {
    color: var(--color-primary);
  }
`;

/** Spacer so fixed-position content above the bar isn't hidden behind it. */
export const BottomBarSpacer = styled.div`
  height: calc(56px + env(safe-area-inset-bottom));
`;

export function BottomTabBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const active = activeTabForPath(location.pathname);
  // Coach is a per-log master switch (default on). When off, drop its tab.
  const { state } = useLifeContext();
  const coachEnabled = state.log?.coachEnabled ?? true;
  const tabs = coachEnabled ? TABS : TABS.filter((t) => t.tab !== "coach");

  return (
    <Bar aria-label="Primary" data-testid="bottom-tab-bar">
      {tabs.map((t) => (
        <TabButton
          key={t.tab}
          type="button"
          $active={active === t.tab}
          aria-current={active === t.tab ? "page" : undefined}
          data-testid={`tab-${t.tab}`}
          onClick={() => navigate(t.path)}
        >
          {t.icon}
          <span>{t.label}</span>
        </TabButton>
      ))}
    </Bar>
  );
}
