/**
 * P2 — EventLogger is driven by `trackable.fields[]`, not unit/shape heuristics
 * keyed off hardcoded ids.
 *
 * Asserts:
 *   - the right editor renders per field type (number / rating / text /
 *     category / bool)
 *   - the write path maps measurement fields → entries[] keyed by field.key,
 *     category fields → labels[field.key]
 *   - ratings preserve the historical {unit:"rating", scale} entry shape so
 *     aggregationFor keeps averaging them
 *   - a multi-field trackable (exercise: duration + intensity + category)
 *     round-trips into one event with the right entry names + labels.category
 *   - one-tap (single count field) logs immediately on card tap
 *
 * Mocks @kirkl/shared so the card mounts without a real backend; the mock
 * `addEvent` captures the (subjectId, entries, options) it was called with.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LifeManifestTrackable, LifeEntry } from "@homelab/backend";

const addEvent = vi.fn().mockResolvedValue("evt1");

vi.mock("@kirkl/shared", async () => {
  const actual = await vi.importActual<typeof import("@kirkl/shared")>("@kirkl/shared");
  return {
    ...actual,
    useFeedback: () => ({
      message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
    }),
    useLifeBackend: () => ({ addEvent }),
  };
});

import { EventLogger } from "./EventLogger";

type AddEventCall = {
  logId: string;
  subjectId: string;
  entries: LifeEntry[];
  userId: string;
  options?: { timestamp?: Date; labels?: Record<string, string> };
};

function lastCall(): AddEventCall {
  const c = addEvent.mock.calls.at(-1)!;
  return { logId: c[0], subjectId: c[1], entries: c[2], userId: c[3], options: c[4] };
}

function renderLogger(trackable: LifeManifestTrackable) {
  return render(
    <EventLogger
      trackable={trackable}
      entries={[]}
      userId="user1"
      logId="log1"
    />,
  );
}

beforeEach(() => {
  addEvent.mockClear();
});

describe("EventLogger field-driven rendering + write path", () => {
  it("single count field renders a one-tap card that logs name=field.key", async () => {
    const user = userEvent.setup();
    const t: LifeManifestTrackable = {
      id: "floss",
      label: "Floss",
      fields: [{ key: "count", type: "number", unit: "ct", defaultValue: 1 }],
    };
    renderLogger(t);

    // One-tap: the whole card is a button labelled to log.
    const logBtn = screen.getByLabelText("Log");
    await user.click(logBtn.closest("div")!);

    expect(addEvent).toHaveBeenCalledTimes(1);
    const call = lastCall();
    expect(call.subjectId).toBe("floss");
    expect(call.entries).toEqual([{ name: "count", type: "number", value: 1, unit: "ct" }]);
    expect(call.options?.labels).toBeUndefined();
  });

  it("single bool field renders a one-tap card writing a bool entry keyed field.key", async () => {
    const user = userEvent.setup();
    const t: LifeManifestTrackable = {
      id: "floss_bool",
      label: "Floss",
      fields: [{ key: "done", type: "bool" }],
    };
    renderLogger(t);

    const logBtn = screen.getByLabelText("Log");
    await user.click(logBtn.closest("div")!);

    const call = lastCall();
    expect(call.entries).toEqual([{ name: "done", type: "bool", value: true }]);
  });

  it("single rating field renders 1..scale buttons and logs unit=rating with scale", async () => {
    const user = userEvent.setup();
    const t: LifeManifestTrackable = {
      id: "mood",
      label: "Mood",
      fields: [{ key: "rating", type: "rating", scale: 5 }],
    };
    renderLogger(t);

    // 1..5 buttons present.
    expect(screen.getByLabelText("Log 4")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Log 4"));

    const call = lastCall();
    expect(call.subjectId).toBe("mood");
    expect(call.entries).toEqual([
      { name: "rating", type: "number", value: 4, unit: "rating", scale: 5 },
    ]);
  });

  it("rating respects a non-default scale", async () => {
    const t: LifeManifestTrackable = {
      id: "pain",
      label: "Pain",
      fields: [{ key: "level", type: "rating", scale: 10 }],
    };
    renderLogger(t);
    // scale 10 → a "10" button exists.
    expect(screen.getByLabelText("Log 10")).toBeInTheDocument();
  });

  it("single text field renders a textarea and logs a text entry keyed field.key", async () => {
    const user = userEvent.setup();
    const t: LifeManifestTrackable = {
      id: "note",
      label: "Note",
      fields: [{ key: "text", type: "text" }],
    };
    renderLogger(t);

    await user.click(screen.getByLabelText("Log"));
    const textarea = await screen.findByRole("textbox");
    await user.type(textarea, "hello world");
    await user.click(screen.getByRole("button", { name: /Log$/ }));

    const call = lastCall();
    expect(call.entries).toEqual([{ name: "text", type: "text", value: "hello world" }]);
  });

  it("multi-field exercise round-trips: number→entry, category→labels, rating→intensity entry", async () => {
    const user = userEvent.setup();
    const t: LifeManifestTrackable = {
      id: "exercise",
      label: "Exercise",
      fields: [
        { key: "duration", type: "number", unit: "min", defaultValue: 30 },
        { key: "category", type: "category", options: ["walk", "run", "bike"] },
        { key: "intensity", type: "rating", scale: 5, optional: true },
      ],
    };
    renderLogger(t);

    // Open the inline form.
    await user.click(screen.getByLabelText("Log"));

    // Pick a category chip + an intensity.
    await user.click(await screen.findByRole("button", { name: "run" }));
    await user.click(screen.getByLabelText("intensity 4"));

    // Submit with the default duration (30 min).
    await user.click(screen.getByRole("button", { name: /Log$/ }));

    const call = lastCall();
    expect(call.subjectId).toBe("exercise");
    // duration (canonical min) + intensity entries; category in labels.
    expect(call.entries).toContainEqual({ name: "duration", type: "number", value: 30, unit: "min" });
    expect(call.entries).toContainEqual({ name: "intensity", type: "number", value: 4, unit: "rating", scale: 5 });
    expect(call.options?.labels).toEqual({ category: "run" });
  });

  it("category field writes labels[field.key], honoring a non-'category' key", async () => {
    const user = userEvent.setup();
    const t: LifeManifestTrackable = {
      id: "movement",
      label: "Movement",
      fields: [
        { key: "kind", type: "category", options: ["walk", "run"] },
        { key: "duration", type: "number", unit: "min", defaultValue: 20 },
      ],
    };
    renderLogger(t);

    await user.click(screen.getByLabelText("Log"));
    await user.click(await screen.findByRole("button", { name: "walk" }));
    await user.click(screen.getByRole("button", { name: /Log$/ }));

    const call = lastCall();
    expect(call.options?.labels).toEqual({ kind: "walk" });
    expect(call.entries).toContainEqual({ name: "duration", type: "number", value: 20, unit: "min" });
  });
});

describe("EventLogger day aggregation reads the primary field key", () => {
  it("sums number entries keyed by the primary field across the day", () => {
    const t: LifeManifestTrackable = {
      id: "water",
      label: "Water",
      fields: [{ key: "volume", type: "number", unit: "oz", defaultValue: 8 }],
    };
    const today = new Date();
    const mkEvent = (id: string, value: number) => ({
      id,
      log: "log1",
      subjectId: "water",
      timestamp: today,
      entries: [{ name: "volume", type: "number" as const, value, unit: "oz" }],
      createdBy: "user1",
      created: today.toISOString(),
      updated: today.toISOString(),
    });
    render(
      <EventLogger
        trackable={t}
        entries={[mkEvent("a", 8), mkEvent("b", 16)]}
        userId="user1"
        logId="log1"
      />,
    );
    // Aggregated value badge shows 24 oz.
    const badge = screen.getByTitle(/entries$/);
    expect(within(badge).getByText(/24/)).toBeInTheDocument();
  });
});
