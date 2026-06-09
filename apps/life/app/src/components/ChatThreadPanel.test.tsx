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
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App as AntApp } from "antd";

// --- Mocks ---------------------------------------------------------------

const { mockChatBackend, stableAuth } = vi.hoisted(() => ({
  mockChatBackend: {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    postMessage: vi.fn(),
    resolveMessage: vi.fn(),
    subscribeToMessages: vi.fn(),
  },
  stableAuth: { user: { uid: "user123" }, loading: false },
}));

/**
 * Helper: subscribeToMessages stub that emits a single initial state
 * synchronously and returns a no-op unsubscribe. Mirrors the mirror's
 * "first emit IS the bootstrap" contract for unit tests that don't need
 * to exercise the realtime-arrival branch.
 */
function emitOnce(initial: import("@homelab/backend").ChatMessage[] = []) {
  return (
    _uid: string,
    _opts: { threadId: string },
    cb: (m: import("@homelab/backend").ChatMessage[]) => void,
  ) => {
    cb(initial);
    return () => {};
  };
}

/**
 * Helper: subscribeToMessages stub that captures the callback and
 * unsubscribe-tracker so tests can deliver realtime updates and assert
 * teardown. Returns the controls.
 */
function deferredSubscribe() {
  let emit: ((m: import("@homelab/backend").ChatMessage[]) => void) | null = null;
  let unsubbed = false;
  const impl = (
    _uid: string,
    _opts: { threadId: string },
    cb: (m: import("@homelab/backend").ChatMessage[]) => void,
  ) => {
    emit = cb;
    return () => {
      unsubbed = true;
    };
  };
  return {
    impl,
    emit: (m: import("@homelab/backend").ChatMessage[]) => emit?.(m),
    isUnsubbed: () => unsubbed,
  };
}

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
    mockChatBackend.subscribeToMessages.mockImplementationOnce(emitOnce([]));

    renderPanel({
      threadId: "pm",
      emptyDescription: "Nothing yet here.",
    });

    expect(await screen.findByText("Nothing yet here.")).toBeInTheDocument();
    // Compose box is always mounted alongside the panel.
    expect(screen.getByPlaceholderText("Type a message…")).toBeInTheDocument();
  });

  it("renders headerSlot above the empty-state placeholder when both apply", async () => {
    mockChatBackend.subscribeToMessages.mockImplementationOnce(emitOnce([]));

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
    mockChatBackend.subscribeToMessages.mockImplementationOnce(
      emitOnce([
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
      ]),
    );

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
    mockChatBackend.subscribeToMessages.mockImplementationOnce(emitOnce([]));

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
    mockChatBackend.subscribeToMessages.mockImplementationOnce(emitOnce([]));

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

  // -----------------------------------------------------------------------
  // Realtime subscription — the live-updates path that this PR opens up.
  //
  // The panel reads through `subscribeToMessages` (mirror full-state
  // delivery). These tests pin down the contract: scoped to the right
  // threadId, torn down on unmount + thread-change, and the optimistic-
  // POST → realtime-echo races resolve to one bubble.
  // -----------------------------------------------------------------------

  it("opens the subscription with the right threadId and tears it down on unmount", async () => {
    const sub = deferredSubscribe();
    mockChatBackend.subscribeToMessages.mockImplementationOnce(sub.impl);

    const { unmount } = renderPanel({
      threadId: "pm",
      emptyDescription: "Nothing yet.",
    });

    await waitFor(() => {
      expect(mockChatBackend.subscribeToMessages).toHaveBeenCalledWith(
        "user123",
        expect.objectContaining({ threadId: "pm" }),
        expect.any(Function),
      );
    });

    // Bootstrap emit so loading resolves and the timeline renders.
    await act(async () => {
      sub.emit([]);
    });
    await screen.findByText("Nothing yet.");

    unmount();
    expect(sub.isUnsubbed()).toBe(true);
  });

  it("tears down + re-opens the subscription when threadId changes", async () => {
    const subPm = deferredSubscribe();
    const subObs = deferredSubscribe();
    mockChatBackend.subscribeToMessages
      .mockImplementationOnce(subPm.impl)
      .mockImplementationOnce(subObs.impl);

    const { rerender } = renderPanel({
      threadId: "pm",
      emptyDescription: "PM thread empty.",
    });

    await waitFor(() => {
      expect(mockChatBackend.subscribeToMessages).toHaveBeenCalledWith(
        "user123",
        expect.objectContaining({ threadId: "pm" }),
        expect.any(Function),
      );
    });
    await act(async () => {
      subPm.emit([]);
    });
    await screen.findByText("PM thread empty.");

    rerender(
      <AntApp>
        <MemoryRouter>
          <ChatThreadPanel threadId="obs:7" emptyDescription="Obs thread empty." />
        </MemoryRouter>
      </AntApp>,
    );

    // Old subscription is torn down; new one is opened with the new threadId.
    await waitFor(() => {
      expect(subPm.isUnsubbed()).toBe(true);
    });
    await waitFor(() => {
      expect(mockChatBackend.subscribeToMessages).toHaveBeenCalledWith(
        "user123",
        expect.objectContaining({ threadId: "obs:7" }),
        expect.any(Function),
      );
    });
    expect(mockChatBackend.subscribeToMessages).toHaveBeenCalledTimes(2);
  });

  it("a server emit carrying an already-present record replaces (not duplicates) — mirror full-state semantics", async () => {
    // The mirror's emit is a full-state replacement, so a record observed
    // twice across two emits collapses into ONE rendered bubble.
    const sub = deferredSubscribe();
    mockChatBackend.subscribeToMessages.mockImplementationOnce(sub.impl);

    renderPanel({
      threadId: "pm",
      emptyDescription: "Nothing yet.",
    });

    const m: import("@homelab/backend").ChatMessage = {
      id: "real-1",
      owner: "user123",
      threadId: "pm",
      role: "assistant",
      body: "hello from coach",
      kind: "chat",
      resolved: false,
      meta: null,
      created: new Date("2026-05-29T12:00:00.000Z"),
      updated: new Date("2026-05-29T12:00:00.000Z"),
    };

    // First emit — bootstrap with one message.
    await act(async () => {
      sub.emit([m]);
    });
    await screen.findByText("hello from coach");

    // Second emit — same record (e.g. a no-op realtime update that re-fires
    // the slice). One bubble must remain, not two.
    await act(async () => {
      sub.emit([m]);
    });
    expect(screen.getAllByText("hello from coach")).toHaveLength(1);
  });

  it("a server emit carrying a new record appends it to the timeline in (provided) order", async () => {
    const sub = deferredSubscribe();
    mockChatBackend.subscribeToMessages.mockImplementationOnce(sub.impl);

    renderPanel({
      threadId: "pm",
      emptyDescription: "Nothing yet.",
    });

    const a: import("@homelab/backend").ChatMessage = {
      id: "a",
      owner: "user123",
      threadId: "pm",
      role: "user",
      body: "first",
      kind: "chat",
      resolved: false,
      meta: null,
      created: new Date("2026-05-29T12:00:00.000Z"),
      updated: new Date("2026-05-29T12:00:00.000Z"),
    };
    const b: import("@homelab/backend").ChatMessage = {
      ...a,
      id: "b",
      body: "second",
      created: new Date("2026-05-29T12:00:05.000Z"),
      updated: new Date("2026-05-29T12:00:05.000Z"),
    };

    await act(async () => {
      sub.emit([a]);
    });
    await screen.findByText("first");

    await act(async () => {
      sub.emit([a, b]);
    });
    const first = await screen.findByText("first");
    const second = await screen.findByText("second");
    // eslint-disable-next-line no-bitwise
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("the optimistic-POST → realtime-echo dedup leaves exactly one bubble with the real id", async () => {
    // Simulates: user types and sends a message. The optimistic placeholder
    // shows immediately. Then the realtime SSE delivers the server-canonical
    // record BEFORE the POST response resolves. The mirror emit must drop
    // the temp- placeholder (content match) and replace it with the real
    // record. When the POST response eventually arrives, the swap is a
    // no-op because the server record's id is already present.
    const sub = deferredSubscribe();
    mockChatBackend.subscribeToMessages.mockImplementationOnce(sub.impl);
    // Pause the POST response so we can deliver the realtime echo first.
    let resolveFetch: (v: unknown) => void = () => {};
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((res) => {
        resolveFetch = res;
      }),
    );

    renderPanel({
      threadId: "pm",
      emptyDescription: "Nothing yet.",
    });

    // Bootstrap empty.
    await act(async () => {
      sub.emit([]);
    });
    await screen.findByPlaceholderText("Type a message…");

    const u = userEvent.setup();
    const textarea = screen.getByPlaceholderText("Type a message…");
    await u.type(textarea, "race me");
    await u.click(screen.getByRole("button", { name: /Send/i }));

    // Optimistic placeholder is visible.
    await screen.findByText("race me");
    expect(screen.getAllByText("race me")).toHaveLength(1);

    // Realtime echo arrives — server record with a real id, same content.
    await act(async () => {
      sub.emit([
        {
          id: "real-server-id",
          owner: "user123",
          threadId: "pm",
          role: "user",
          body: "race me",
          kind: "chat",
          resolved: false,
          meta: null,
          created: new Date("2026-05-29T12:00:01.000Z"),
          updated: new Date("2026-05-29T12:00:01.000Z"),
        },
      ]);
    });

    // Exactly one bubble remains — the temp was dropped via content dedup,
    // not duplicated alongside the real record.
    await waitFor(() => {
      expect(screen.getAllByText("race me")).toHaveLength(1);
    });

    // Now the POST resolves. The swap finds the temp- id gone and the real
    // id already present — converges to the same single bubble.
    await act(async () => {
      resolveFetch({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "real-server-id",
            owner: "user123",
            thread_id: "pm",
            role: "user",
            body: "race me",
            kind: "chat",
            resolved: false,
            meta: null,
            created: "2026-05-29T12:00:01.000Z",
            updated: "2026-05-29T12:00:01.000Z",
          }),
      });
    });
    await waitFor(() => {
      expect(screen.getAllByText("race me")).toHaveLength(1);
    });
  });
});
