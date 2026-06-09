/**
 * Component tests for Chat.tsx — the /chat surface (PM-iteration channel).
 *
 * After the thread-split refactor, `/chat` is ONLY for the PM-iteration
 * channel. The previous `?observation=<id>` deep-link handoff is gone —
 * observation reply threads now live at `/observations/:id` and are
 * tested in ObservationDetail.test.tsx.
 *
 * This file is small on purpose: most of the timeline + compose-box logic
 * lives in `ChatThreadPanel`. The tests here pin down the contract that
 * matters at the Chat boundary:
 *   - lists with `threadId="pm"` (no merging across threads)
 *   - posts with `thread_id: "pm"`
 *   - no `?observation=` handling
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { App as AntApp } from "antd";

// --- Mocks ---------------------------------------------------------------

// Hoisted because `vi.mock` factories run before module-top-level code.
// Stable identities — recreating these per-render would change the deps of
// the panel's `loadMessages` useCallback (which keys on `user` + `chat`),
// causing the mount useEffect to re-fire every commit and loop.
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
    // Render-only stub so we don't drag in AppHeader's full dropdown
    // machinery in jsdom. Keep an `onBack` affordance so the test can find
    // the back button if it wants to.
    AppHeader: ({ title, onBack }: { title: ReactNode; onBack?: () => void }) => (
      <header>
        {onBack && <button onClick={onBack}>back</button>}
        <span>{title}</span>
      </header>
    ),
  };
});

// --- Imports under test (after mocks) ------------------------------------

import { Chat } from "./Chat";

function renderChat(initialEntry = "/chat") {
  return render(
    <AntApp>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/chat" element={<Chat />} />
        </Routes>
      </MemoryRouter>
    </AntApp>,
  );
}

// --- Tests ---------------------------------------------------------------

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom doesn't ship a fetch; tests that exercise the send path install
    // their own. The empty-state + initial-load tests rely solely on the
    // mocked backend, so a fetch leak there is a real bug worth surfacing.
    (globalThis as { fetch?: unknown }).fetch = vi.fn();
  });

  it("lists messages with threadId='pm' on mount", async () => {
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    renderChat();

    await screen.findByText(/Nothing yet — the PM agent will post deploy nudges/);

    expect(mockChatBackend.listMessages).toHaveBeenCalledWith(
      "user123",
      expect.objectContaining({ threadId: "pm" }),
    );
  });

  it("ignores `?observation=<id>` in the URL — does not call the observer backend or prefill the compose box", async () => {
    // The thread-split refactor removed the D3 `?observation=` deep-link
    // path from /chat. The handoff now navigates to /observations/:id,
    // which is its own dedicated thread. Confirm /chat no longer reacts
    // to the legacy param.
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    renderChat("/chat?observation=obs-42");

    const textarea = (await screen.findByPlaceholderText("Type a message…")) as HTMLTextAreaElement;
    // Compose box stays empty.
    expect(textarea.value).toBe("");
    // The list call still keyed off "pm" — the param did not leak into a
    // cross-thread read.
    expect(mockChatBackend.listMessages).toHaveBeenCalledWith(
      "user123",
      expect.objectContaining({ threadId: "pm" }),
    );
  });

  it("send flow posts with thread_id='pm'", async () => {
    const user = userEvent.setup();
    mockChatBackend.listMessages.mockResolvedValueOnce([]);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "server1",
          owner: "user123",
          thread_id: "pm",
          role: "user",
          body: "hello pm",
          kind: "chat",
          resolved: false,
          meta: null,
          created: "2026-05-29T12:00:01.000Z",
          updated: "2026-05-29T12:00:01.000Z",
        }),
    });

    renderChat();

    await screen.findByText(/Nothing yet/);

    const textarea = screen.getByPlaceholderText("Type a message…");
    await user.type(textarea, "hello pm");

    const sendBtn = screen.getByRole("button", { name: /Send/i });
    await user.click(sendBtn);

    await screen.findByText("hello pm");

    // POST hit the chat endpoint with thread_id="pm".
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/chat/messages"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"thread_id":"pm"'),
        }),
      );
    });

    // After the send, the textarea is cleared.
    expect((textarea as HTMLTextAreaElement).value).toBe("");

    // listMessages was called exactly once (the initial mount load). No
    // post-send refetch — a refetch failure after a successful POST would
    // prompt the user to retry, producing a duplicate on the server.
    expect(mockChatBackend.listMessages).toHaveBeenCalledTimes(1);
  });
});
