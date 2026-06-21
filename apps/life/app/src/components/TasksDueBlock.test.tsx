/**
 * Component test for TasksDueBlock's leaf-vs-group filtering.
 *
 * The morning "Today's upkeep" block must surface only LEAF tasks (actionable
 * todos), never GROUP/container nodes — the SAME structural rule the server
 * notification crons use (services/api/.../notifications/recipients.ts's
 * fetchParentIds): a task with ANY child is a group.
 *
 * Harness: mock @kirkl/shared so the block mounts without PocketBase. We
 * capture the subscribeToList `onTasks` callback and feed it a flat task set
 * synchronously, then assert which names render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { Task as BackendTask } from "@homelab/backend";

// --- Mocks ---------------------------------------------------------------

// Captured onTasks emitter for the single subscribed list.
let emitTasks: ((tasks: BackendTask[]) => void) | null = null;

const mockUpkeepBackend = {
  subscribeToList: vi.fn(
    (
      _listId: string,
      _userId: string,
      handlers: { onTasks: (tasks: BackendTask[]) => void },
    ) => {
      emitTasks = handlers.onTasks;
      return () => {
        emitTasks = null;
      };
    },
  ),
};

const mockUserBackend = {
  // Synchronously hand the block a one-list slug map, then return unsub.
  subscribeSlugs: vi.fn(
    (_uid: string, _kind: string, cb: (slugs: Record<string, string>) => void) => {
      cb({ home: "list1" });
      return () => {};
    },
  ),
};

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useAuth: () => ({ user: { uid: "user123" }, loading: false }),
    useUpkeepBackend: () => mockUpkeepBackend,
    useUserBackend: () => mockUserBackend,
  };
});

// --- Imports under test (after mocks) ------------------------------------

import { TasksDueBlock } from "./TasksDueBlock";

// --- Task fixtures -------------------------------------------------------

function base(id: string, name: string, parentId = ""): BackendTask {
  return {
    id,
    list: "list1",
    parentId,
    path: parentId ? `${parentId}/${id}` : id,
    position: 0,
    name,
    description: "",
    snoozedUntil: null,
    assignees: [],
    createdBy: "user123",
    tags: [],
    collapsed: false,
    created: "2026-01-01 00:00:00",
    updated: "2026-01-01 00:00:00",
    // overwritten by the variant spreads below
    taskType: "recurring",
    frequency: { value: 1, unit: "days" },
    lastCompleted: null,
  } as BackendTask;
}

/** A recurring task that is due today (never completed → immediately due). */
function recurringDue(id: string, name: string, parentId = ""): BackendTask {
  return {
    ...base(id, name, parentId),
    taskType: "recurring",
    frequency: { value: 1, unit: "days" },
    lastCompleted: null,
  } as BackendTask;
}

/** A someday (undated, open) one-shot → surfaces in the "Asap" bucket. */
function asapOneShot(id: string, name: string, parentId = ""): BackendTask {
  return {
    ...base(id, name, parentId),
    taskType: "one_shot",
    schedule: { kind: "someday" },
    completed: false,
    cleared: false,
  } as BackendTask;
}

function emit(tasks: BackendTask[]) {
  act(() => {
    emitTasks?.(tasks);
  });
}

// --- Tests ---------------------------------------------------------------

describe("TasksDueBlock leaf filtering", () => {
  beforeEach(() => {
    emitTasks = null;
    vi.clearAllMocks();
  });

  it("renders a recurring-due LEAF child but not its recurring-due PARENT", () => {
    render(<TasksDueBlock />);
    emit([
      recurringDue("parent", "Kitchen chores"),
      recurringDue("child", "Wipe counters", "parent"),
    ]);

    expect(screen.getByText("Wipe counters")).toBeTruthy();
    expect(screen.queryByText("Kitchen chores")).toBeNull();
  });

  it("renders an asap one-shot LEAF child but not its asap one-shot PARENT", () => {
    render(<TasksDueBlock />);
    emit([
      asapOneShot("parent", "Trip prep"),
      asapOneShot("child", "Book flights", "parent"),
    ]);

    expect(screen.getByText("Book flights")).toBeTruthy();
    expect(screen.queryByText("Trip prep")).toBeNull();
  });

  it("renders a childless task (it is a leaf)", () => {
    render(<TasksDueBlock />);
    emit([recurringDue("solo", "Water plants")]);

    expect(screen.getByText("Water plants")).toBeTruthy();
  });
});
