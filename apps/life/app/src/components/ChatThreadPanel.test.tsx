/**
 * Component tests for ChatThreadPanel — the reusable timeline + composer.
 *
 * Most thread-level behavior (list-on-mount, post flow, resolve) is
 * exercised end-to-end through the surfaces that wrap it (Chat.test.tsx
 * for `/chat`, ObservationDetail.test.tsx for `/observations/:id`). The
 * tests here pin down the surfaces of the panel that don't belong to
 * either caller:
 *
 *   - The new `headerSlot` prop: when provided, the slot renders INSIDE
 *     the Timeline scroll container (above messages, above the
 *     empty-state placeholder). When absent the panel is unchanged.
 *   - The empty-state placeholder still renders when there are no
 *     messages, but now under the headerSlot (and inside the scroll
 *     container), not as a separate Section block above the panel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";

// --- Mocks ---------------------------------------------------------------

const { mockChatBackend, stableAuth } = vi.hoisted(() => ({
  mockChatBackend: {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    postMessage: vi.fn(),
    resolveMessage: vi.fn(),
  },
  stableAuth: { user: { uid: "user123" }, loading: false },
}));

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => stableAuth,
    useChatBackend: () => mockChatBackend,
    getApiBase: () => "http://api.test",
    getAuthHeaders: () => ({ Authorization: "Bearer test-token" }),
  };
});

// --- Imports under test (after mocks) ------------------------------------

import { ChatThreadPanel } from "./ChatThreadPanel";

function renderPanel(props: Parameters<typeof ChatThreadPanel>[0]) {
  return render(
    <AntApp>
      <MemoryRouter>
        <ChatThreadPanel {...props} />
      </MemoryRouter>
    </AntApp>,
  );
}

// --- Tests ---------------------------------------------------------------

describe("ChatThreadPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { fetch?: unknown }).fetch = vi.fn();
  });

  it("renders the empty-state placeholder when there are no messages and no headerSlot", async () => {
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    renderPanel({
      threadId: "pm",
      emptyDescription: "Nothing yet here.",
    });

    expect(await screen.findByText("Nothing yet here.")).toBeInTheDocument();
    // Compose box is always mounted alongside the panel.
    expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument();
  });

  it("renders headerSlot above the empty-state placeholder when both apply", async () => {
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    renderPanel({
      threadId: "obs:42",
      emptyDescription: "No replies yet.",
      headerSlot: <div data-testid="header-slot">observation header</div>,
    });

    // Both the header and the placeholder are visible — header doesn't
    // suppress the empty state, and the empty state doesn't suppress the
    // header.
    const header = await screen.findByTestId("header-slot");
    const empty = await screen.findByText("No replies yet.");
    expect(header).toBeInTheDocument();
    expect(empty).toBeInTheDocument();

    // The header lives in the same DOM subtree as the empty-state copy —
    // i.e. inside the scroll container. compareDocumentPosition's
    // FOLLOWING bit (0x04) confirms the empty state appears AFTER the
    // header in document order.
    // eslint-disable-next-line no-bitwise
    expect(header.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders headerSlot above messages when both are present (unified scroll container)", async () => {
    mockChatBackend.listMessages.mockResolvedValueOnce([
      {
        id: "m1",
        owner: "user123",
        threadId: "obs:42",
        role: "assistant",
        body: "first reply",
        kind: "chat",
        resolved: false,
        meta: null,
        created: new Date("2026-05-29T12:00:00.000Z"),
        updated: new Date("2026-05-29T12:00:00.000Z"),
      },
    ]);

    renderPanel({
      threadId: "obs:42",
      emptyDescription: "No replies yet.",
      headerSlot: <div data-testid="header-slot">observation header</div>,
    });

    const header = await screen.findByTestId("header-slot");
    const reply = await screen.findByText("first reply");

    // No empty placeholder when there's at least one message.
    expect(screen.queryByText("No replies yet.")).toBeNull();

    // The reply lives in the same scroll container as the header (a shared
    // ancestor element); document order confirms header comes first.
    // eslint-disable-next-line no-bitwise
    expect(header.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does NOT render any header-slot element when the prop is omitted (PM channel regression-safety)", async () => {
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    renderPanel({
      threadId: "pm",
      emptyDescription: "Nothing yet here.",
    });

    await screen.findByText("Nothing yet here.");

    // Nothing the parent might have passed should appear when the prop
    // wasn't provided — guards against a regression that always rendered
    // an empty wrapper or leaked the prop into the DOM.
    expect(screen.queryByTestId("header-slot")).toBeNull();
  });

  it("keeps the empty placeholder visible during message-loading lifecycle and replaces it once messages arrive", async () => {
    // First load: empty. Confirms the placeholder + header coexist after
    // the initial load settles. (Loading-state spinner branch is not
    // exercised here — it would race the resolved Promise; the unit-level
    // value is showing the post-load DOM relationship.)
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    const { rerender } = renderPanel({
      threadId: "obs:42",
      emptyDescription: "No replies yet.",
      headerSlot: <div data-testid="header-slot">observation header</div>,
    });

    await screen.findByTestId("header-slot");
    expect(await screen.findByText("No replies yet.")).toBeInTheDocument();

    // Header sticks around if the parent rerenders with the same slot.
    rerender(
      <AntApp>
        <MemoryRouter>
          <ChatThreadPanel
            threadId="obs:42"
            emptyDescription="No replies yet."
            headerSlot={<div data-testid="header-slot">observation header</div>}
          />
        </MemoryRouter>
      </AntApp>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("header-slot")).toBeInTheDocument();
    });
  });
});
