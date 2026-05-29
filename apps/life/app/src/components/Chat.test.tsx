/**
 * Component tests for Chat.tsx — the /chat surface (Phase C2).
 *
 * Mocks @kirkl/shared so we can stub useChatBackend.listMessages (the read
 * path) and useAuth, plus the global `fetch` for the two POST paths (send +
 * resolve). Mirrors LifeDashboard.test.tsx's mock layout for consistency.
 *
 * Covers (per the C2 brief):
 *   - empty state render
 *   - send flow (optimistic-append + refetch)
 *   - "Mark resolved" flow (optimistic flip + POST)
 *   - kind-badge render for a `question`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { App as AntApp } from "antd";
import type { ChatMessage } from "@homelab/backend";

// --- Mocks ---------------------------------------------------------------

// Hoisted because `vi.mock` factories run before module-top-level code.
// Stable identities — recreating these per-render would change the deps of
// the Chat component's `loadMessages` useCallback (which keys on `user` +
// `chat`), causing the mount useEffect to re-fire every commit and loop.
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
    // The Chat component reads getApiBase()/getAuthHeaders() via the real
    // implementations, but the global `fetch` is stubbed per-test, so those
    // helpers' actual return values don't matter — they just feed into the
    // fetch call's URL/headers, which the mock ignores.
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

// --- Helpers -------------------------------------------------------------

function makeMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  const now = new Date("2026-05-29T12:00:00.000Z");
  return {
    owner: "user123",
    role: "user",
    body: "",
    kind: "chat",
    resolved: false,
    meta: null,
    created: now,
    updated: now,
    ...overrides,
  } as ChatMessage;
}

// --- Imports under test (after mocks) ------------------------------------

import { Chat } from "./Chat";

function renderChat() {
  return render(
    <AntApp>
      <MemoryRouter initialEntries={["/chat"]}>
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
    // jsdom doesn't ship a fetch; tests that exercise the send/resolve paths
    // install their own. The empty-state + initial-load tests rely solely on
    // the mocked backend, so a fetch leak there is a real bug worth surfacing.
    (globalThis as { fetch?: unknown }).fetch = vi.fn();
  });

  it("renders the empty state when there are no messages", async () => {
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    renderChat();

    expect(
      await screen.findByText(/Nothing yet — the PM agent will post deploy nudges/),
    ).toBeInTheDocument();
    // The composer is still mounted in the empty state.
    expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument();
  });

  it("renders a kind badge for a `question` from the assistant", async () => {
    mockChatBackend.listMessages.mockResolvedValueOnce([
      makeMessage({
        id: "m1",
        role: "assistant",
        kind: "question",
        body: "Did the deploy land OK?",
      }),
    ]);

    renderChat();

    // Question badge is rendered.
    expect(await screen.findByText("Question")).toBeInTheDocument();
    // Body is rendered (through react-markdown).
    expect(screen.getByText("Did the deploy land OK?")).toBeInTheDocument();
    // Resolve affordance is offered for unresolved assistant questions.
    expect(screen.getByRole("button", { name: /Mark resolved/i })).toBeInTheDocument();
  });

  it("send flow: posts the message and swaps in the canonical server record", async () => {
    const user = userEvent.setup();
    // Initial list is empty. The POST response (the raw PB record shape) is
    // mapped client-side and swapped in over the optimistic placeholder —
    // there is intentionally NO refetch (a refetch failure after a successful
    // POST would prompt the user to retry, duplicating the message server-side).
    mockChatBackend.listMessages.mockResolvedValueOnce([]);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "server1",
          owner: "user123",
          role: "user",
          body: "hello from test",
          kind: "chat",
          resolved: false,
          meta: null,
          created: "2026-05-29T12:00:01.000Z",
          updated: "2026-05-29T12:00:01.000Z",
        }),
    });

    renderChat();

    // Wait for initial empty-state render.
    await screen.findByText(/Nothing yet/);

    const textarea = screen.getByPlaceholderText("Type a message…");
    await user.type(textarea, "hello from test");

    const sendBtn = screen.getByRole("button", { name: /Send/i });
    await user.click(sendBtn);

    // The optimistic insert appears immediately; then the inline swap
    // replaces it with the canonical server record. Asserting the body is
    // visible covers both cases since they share the text.
    await screen.findByText("hello from test");

    // POST hit the chat endpoint with the right payload.
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/chat/messages"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("hello from test"),
        }),
      );
    });

    // After the send, the textarea is cleared.
    expect((textarea as HTMLTextAreaElement).value).toBe("");

    // Crucially: listMessages was called exactly once (the initial mount
    // load). No post-send refetch — that's the whole point of fix #3.
    expect(mockChatBackend.listMessages).toHaveBeenCalledTimes(1);
  });

  it("resolve flow: clicking Mark resolved POSTs to /resolve and flips the badge", async () => {
    const user = userEvent.setup();
    mockChatBackend.listMessages.mockResolvedValueOnce([
      makeMessage({
        id: "m42",
        role: "assistant",
        kind: "question",
        body: "Looks good?",
      }),
    ]);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "m42", resolved: true }),
    });

    renderChat();

    const resolveBtn = await screen.findByRole("button", { name: /Mark resolved/i });
    await user.click(resolveBtn);

    // The POST hit the /resolve endpoint.
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/chat/messages/m42/resolve"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    // After the optimistic flip, the "Mark resolved" button is gone and the
    // bubble now reads "resolved".
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Mark resolved/i })).toBeNull();
    });
    expect(screen.getByText("resolved")).toBeInTheDocument();
  });
});
