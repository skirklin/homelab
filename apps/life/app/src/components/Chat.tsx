/**
 * /chat — PM ↔ user chat channel (thread = `"pm"`).
 *
 * This surface is ONLY for the PM-iteration channel — talking about the
 * product itself. Observation reply threads (talking about Scott's life)
 * live at `/observations/:id`. The two are deliberately separate after
 * the thread_id refactor: they used to share a chat collection + Coach
 * SDK session, which contaminated context across surfaces. Now this page
 * reads/writes only `thread_id="pm"` and the Coach service keys its SDK
 * session per-`(owner, thread_id)`.
 *
 * Timeline shape, compose box, and message rendering live in
 * `ChatThreadPanel` — extracted so `ObservationDetail.tsx` can reuse the
 * exact same surface for `thread_id="obs:<id>"`.
 */
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { BookOutlined, LineChartOutlined, RobotOutlined } from "@ant-design/icons";
import { AppHeader, PageContainer } from "@kirkl/shared";
import { ChatThreadPanel } from "./ChatThreadPanel";
import { useLifeContext } from "../life-context";

// Wrap header + container in a flex column pinned to the dynamic viewport
// height so the composer reliably hugs the bottom on iOS PWAs (where the
// home-bar / address-bar dance makes 100vh wrong) and notched devices
// (where AppHeader expands to cover env(safe-area-inset-top), making any
// hardcoded header offset wrong). `100dvh` was designed for exactly this
// case; the previous `calc(100vh - 64px)` clipped the composer below the
// visible viewport on iOS PWA with a notch (real header ≈ 52px + space-sm +
// safe-area-inset-top, not 64px).
const ChatShell = styled.div`
  display: flex;
  flex-direction: column;
  height: 100dvh;
`;

// The page itself becomes a flex column so the timeline scrolls and the
// composer sits flush at the bottom. PageContainer adds its own padding;
// we override the bottom padding to 0 so the sticky composer hugs the edge.
// `min-height: 0` is required so the inner flex children (Timeline) can
// actually overflow + scroll instead of forcing the parent to grow.
const ChatPageContainer = styled(PageContainer)`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding-bottom: 0;
`;

export function Chat() {
  const navigate = useNavigate();
  // /chat is unlinked from nav and not Coach-gated itself, but its menu links
  // into Coach surfaces — omit those when Coach is disabled.
  const { state } = useLifeContext();
  const coachEnabled = state.log?.coachEnabled ?? true;
  const journalEnabled = state.log?.journalEnabled ?? true;

  const menuItems = [
    ...(journalEnabled
      ? [{ key: "journal", icon: <BookOutlined />, label: "Journal", onClick: () => navigate("/journal") }]
      : []),
    ...(coachEnabled
      ? [
          { key: "insights", icon: <LineChartOutlined />, label: "Insights", onClick: () => navigate("/insights") },
          { key: "observations", icon: <RobotOutlined />, label: "Observations", onClick: () => navigate("/observations") },
        ]
      : []),
  ];

  return (
    <ChatShell>
      <AppHeader title="Chat" onBack={() => navigate("/")} menuItems={menuItems} />

      <ChatPageContainer>
        <ChatThreadPanel
          threadId="pm"
          emptyDescription="Nothing yet — the PM agent will post deploy nudges + UX questions here after the next tick. You can also start a conversation."
        />
      </ChatPageContainer>
    </ChatShell>
  );
}
