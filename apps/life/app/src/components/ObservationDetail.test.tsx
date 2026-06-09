/**
 * Component tests for ObservationDetail.tsx — the /observations/:id surface.
 *
 * Each observation has its own chat thread keyed `thread_id = "obs:<id>"`.
 * This page reads the observation from the observer backend, renders it on
 * top, and mounts a `ChatThreadPanel` below filtered to the same thread.
 *
 * Coverage:
 *   - listMessages is called with `threadId: "obs:<id>"` derived from the URL.
 *   - Posts go out with the same thread_id in the body.
 *   - An empty thread renders the placeholder copy.
 *   - A missing/unknown observation falls back to a not-found state and
 *     does NOT mount the chat panel (no list call).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { App as AntApp } from "antd";
import type { ClaudeObservation } from "@homelab/backend";

// --- Mocks ---------------------------------------------------------------

const { mockChatBackend, mockObserverBackend, stableAuth } = vi.hoisted(() => ({
  mockChatBackend: {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    postMessage: vi.fn(),
    resolveMessage: vi.fn(),
  },
  mockObserverBackend: {
    listObservations: vi.fn(),
    getObservation: vi.fn(),
    createObservation: vi.fn(),
  },
  stableAuth: { user: { uid: "user123" }, loading: false },
}));

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => stableAuth,
    useChatBackend: () => mockChatBackend,
    useObserverBackend: () => mockObserverBackend,
    getApiBase: () => "http://api.test",
    getAuthHeaders: () => ({ Authorization: "Bearer test-token" }),
    AppHeader: ({ title, onBack }: { title: ReactNode; onBack?: () => void }) => (
      <header>
        {onBack && <button onClick={onBack}>back</button>}
        <span>{title}</span>
      </header>
    ),
  };
});

// --- Helpers -------------------------------------------------------------

function makeObservation(overrides: Partial<ClaudeObservation> & { id: string }): ClaudeObservation {
  const now = new Date("2026-05-29T12:00:00.000Z");
  return {
    owner: "user123",
    content: "Sample observation body.",
    period: "weekly",
    dataWindowStart: new Date("2026-05-22T12:00:00.000Z"),
    dataWindowEnd: now,
    relatedEventIds: [],
    promptVersion: "v0",
    created: now,
    ...overrides,
  } as ClaudeObservation;
}

// --- Imports under test (after mocks) ------------------------------------

import { ObservationDetail } from "./ObservationDetail";

function renderDetail(id: string) {
  return render(
    <AntApp>
      <MemoryRouter initialEntries={[`/observations/${id}`]}>
        <Routes>
          <Route path="/observations/:id" element={<ObservationDetail />} />
        </Routes>
      </MemoryRouter>
    </AntApp>,
  );
}

// --- Tests ---------------------------------------------------------------

describe("ObservationDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { fetch?: unknown }).fetch = vi.fn();
  });

  it("filters chat by threadId='obs:<id>' from the URL and renders the placeholder when empty", async () => {
    mockObserverBackend.getObservation.mockResolvedValueOnce(
      makeObservation({ id: "obs-42", content: "You wrote that you wanted to run more." }),
    );
    mockChatBackend.listMessages.mockResolvedValueOnce([]);

    renderDetail("obs-42");

    // Observation body renders.
    await screen.findByText("You wrote that you wanted to run more.");

    // listMessages was called with the correct threadId derived from :id.
    await waitFor(() => {
      expect(mockChatBackend.listMessages).toHaveBeenCalledWith(
        "user123",
        expect.objectContaining({ threadId: "obs:obs-42" }),
      );
    });

    // Empty-state placeholder renders.
    expect(
      await screen.findByText(/No replies yet\. Start a conversation about this observation/),
    ).toBeInTheDocument();

    // Compose box is mounted even when empty.
    expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument();
  });

  it("posting a new message uses thread_id='obs:<id>'", async () => {
    const user = userEvent.setup();
    mockObserverBackend.getObservation.mockResolvedValueOnce(
      makeObservation({ id: "obs-99" }),
    );
    mockChatBackend.listMessages.mockResolvedValueOnce([]);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          id: "server1",
          owner: "user123",
          thread_id: "obs:obs-99",
          role: "user",
          body: "thoughts on this",
          kind: "chat",
          resolved: false,
          meta: null,
          created: "2026-05-29T12:00:01.000Z",
          updated: "2026-05-29T12:00:01.000Z",
        }),
    });

    renderDetail("obs-99");

    // Wait for the observation + empty panel to settle so the textarea is
    // mounted (the panel is gated behind the observation fetch).
    await screen.findByPlaceholderText("Type a message…");

    const textarea = screen.getByPlaceholderText("Type a message…");
    await user.type(textarea, "thoughts on this");

    const sendBtn = screen.getByRole("button", { name: /Send/i });
    await user.click(sendBtn);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/chat/messages"),
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"thread_id":"obs:obs-99"'),
        }),
      );
    });
  });

  it("renders a not-found placeholder when the observation fetch fails and does NOT mount the chat panel", async () => {
    mockObserverBackend.getObservation.mockRejectedValueOnce(new Error("404"));

    renderDetail("ghost-id");

    expect(await screen.findByText(/404|Observation not found/)).toBeInTheDocument();

    // The chat panel never mounted, so no listMessages call was made.
    expect(mockChatBackend.listMessages).not.toHaveBeenCalled();
    // Compose box is not rendered in the not-found state.
    expect(screen.queryByPlaceholderText("Type a message…")).toBeNull();
  });
});
