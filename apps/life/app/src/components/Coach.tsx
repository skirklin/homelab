/**
 * Coach — the AI / analysis hub. Unifies the two Claude-facing surfaces behind
 * one Insights ⇄ Observations segmented toggle (mirrors the Today screen's
 * lens toggle). Observations is the default (the AI feed).
 *
 * The segmented toggle drives the URL: it navigates between `/insights` and
 * `/observations`, which remain real, deep-linkable routes. Coach is mounted on
 * all three (`/coach`, `/insights`, `/observations`) and picks the active view
 * from the path, so a direct hit on `/insights` lands here with the right tab
 * selected and the bottom bar's Coach tab highlighted.
 */
import { lazy, Suspense } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Segmented, Spin } from "antd";
import { AppHeader } from "@kirkl/shared";
import { useSettingsMenu } from "../settings-menu";

const Visualizations = lazy(() =>
  import("./Visualizations").then((m) => ({ default: m.Visualizations })),
);
const Observations = lazy(() =>
  import("./Observations").then((m) => ({ default: m.Observations })),
);

type CoachView = "insights" | "observations";

const ToggleRow = styled.div`
  display: flex;
  justify-content: center;
  padding: var(--space-md) var(--space-md) 0;
`;

const LoadingWrap = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

function viewForPath(pathname: string): CoachView {
  // /coach and /observations both land on the AI feed; only /insights selects
  // the charts view.
  return pathname === "/insights" ? "insights" : "observations";
}

export function Coach() {
  const navigate = useNavigate();
  const location = useLocation();
  const view = viewForPath(location.pathname);
  const { menuItems } = useSettingsMenu();

  return (
    <>
      <AppHeader title="Coach" menuItems={menuItems} />
      <ToggleRow>
        <Segmented<CoachView>
          value={view}
          onChange={(v) => navigate(v === "insights" ? "/insights" : "/observations")}
          options={[
            { label: "Observations", value: "observations" },
            { label: "Insights", value: "insights" },
          ]}
          data-testid="coach-toggle"
        />
      </ToggleRow>
      <Suspense
        fallback={
          <LoadingWrap>
            <Spin size="large" />
          </LoadingWrap>
        }
      >
        {view === "insights" ? <Visualizations /> : <Observations />}
      </Suspense>
    </>
  );
}
