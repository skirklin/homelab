/**
 * Cross-origin deep-link regression (push notifications).
 *
 * PocketBase auth is per-origin localStorage. A push delivered to the embedded
 * `kirkl.in` subscription must deep-link to a SAME-ORIGIN relative path
 * (`/travel/{id}/...`), not an absolute `https://travel.kirkl.in/...` URL — the
 * latter cold-loads an origin whose localStorage is empty, presenting as a
 * forced sign-out.
 *
 * `sendPushToUser` already chooses one delivery origin per user (via
 * `preferredOrigins`). These tests pin that an optional `buildUrl(origin)`
 * path-builder is invoked with THAT chosen origin, so the emitted `url` is
 * always correct for where the push actually lands.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// push.ts reads VAPID keys at import-time; set them before importing the unit.
// `vi.hoisted` runs before the (hoisted) ESM imports below.
vi.hoisted(() => {
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
});

// web-push is mocked: capture the JSON payload pushed to each subscription so
// we can assert on the `url` field without configuring VAPID or hitting network.
const sendNotification = vi.fn().mockResolvedValue(undefined);
const setVapidDetails = vi.fn();
vi.mock("web-push", () => ({
  default: {
    sendNotification: (...a: unknown[]) => sendNotification(...a),
    setVapidDetails: (...a: unknown[]) => setVapidDetails(...a),
  },
}));

import { sendPushToUser } from "./push";
import { tripUrl, dayUrl } from "./notifications/travel";
import { sessionUrl } from "./notifications/life";
import { tasksUrl } from "./notifications/deadlines";

beforeEach(() => {
  vi.clearAllMocks();
});

interface FakeSub {
  id: string;
  origin?: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function makeFakePb(subs: FakeSub[]) {
  return {
    filter: (expr: string, _params: Record<string, unknown>) => expr,
    collection() {
      return {
        getFullList: async () => subs,
        delete: async () => {},
      };
    },
  } as never;
}

/** Parse the URL out of the JSON body handed to web-push for a given endpoint. */
function pushedUrlFor(endpoint: string): string | undefined {
  const call = sendNotification.mock.calls.find(
    ([sub]) => (sub as { endpoint: string }).endpoint === endpoint,
  );
  if (!call) return undefined;
  return JSON.parse(call[1] as string).url;
}

const sub = (id: string, origin: string): FakeSub => ({
  id,
  origin,
  endpoint: `https://push.example/${id}`,
  keys: { p256dh: "p", auth: "a" },
});

describe("sendPushToUser — origin-aware deep link (buildUrl)", () => {
  it("delivers a SAME-ORIGIN relative path to the embedded kirkl.in subscription", async () => {
    // User only has an embedded subscription. The push must NOT carry an
    // absolute travel.kirkl.in URL.
    const pb = makeFakePb([sub("s1", "https://kirkl.in")]);
    const buildUrl = (origin: string) =>
      origin === "https://travel.kirkl.in" ? "/T1/day/2026-06-02" : "/travel/T1/day/2026-06-02";

    await sendPushToUser(
      pb,
      "user1",
      { title: "How was today?", buildUrl },
      { preferredOrigins: ["https://travel.kirkl.in", "https://kirkl.in"] },
    );

    const url = pushedUrlFor("https://push.example/s1");
    expect(url).toBe("/travel/T1/day/2026-06-02");
    expect(url).not.toContain("https://travel.kirkl.in");
    expect(url!.startsWith("/")).toBe(true);
  });

  it("delivers the standalone path to the travel.kirkl.in subscription", async () => {
    const pb = makeFakePb([sub("s2", "https://travel.kirkl.in")]);
    const buildUrl = (origin: string) =>
      origin === "https://travel.kirkl.in" ? "/T1/day/2026-06-02" : "/travel/T1/day/2026-06-02";

    await sendPushToUser(
      pb,
      "user1",
      { title: "How was today?", buildUrl },
      { preferredOrigins: ["https://travel.kirkl.in", "https://kirkl.in"] },
    );

    expect(pushedUrlFor("https://push.example/s2")).toBe("/T1/day/2026-06-02");
  });

  it("buildUrl receives the empty origin for legacy subs with no recorded origin", async () => {
    const legacy: FakeSub = {
      id: "s3",
      endpoint: "https://push.example/s3",
      keys: { p256dh: "p", auth: "a" },
    };
    const pb = makeFakePb([legacy]);
    const seen: string[] = [];
    const buildUrl = (origin: string) => {
      seen.push(origin);
      return "/travel/T1";
    };

    await sendPushToUser(
      pb,
      "user1",
      { title: "x", buildUrl },
      { preferredOrigins: ["https://travel.kirkl.in", "https://kirkl.in"] },
    );

    // Legacy fallback path still resolves a (relative) url; origin is "".
    expect(seen).toContain("");
    expect(pushedUrlFor("https://push.example/s3")).toBe("/travel/T1");
  });

  it("static url still works (buildUrl absent)", async () => {
    const pb = makeFakePb([sub("s4", "https://kirkl.in")]);
    await sendPushToUser(pb, "user1", { title: "x", url: "/static" });
    expect(pushedUrlFor("https://push.example/s4")).toBe("/static");
  });
});

// Exercises the REAL origin-branching in travel.ts (tripUrl/dayUrl/travelBase)
// rather than an inlined mirror, so the legacy-"" mapping can't regress silently.
// DOMAIN defaults to kirkl.in: embedded origin = https://kirkl.in (home shell,
// trip mounts under /travel/*); standalone = https://travel.kirkl.in (trip at
// root). Legacy subs (no recorded origin, pre-migration-0014) were registered on
// the standalone app, so the empty origin MUST resolve like standalone — root,
// no /travel prefix — not embedded.
describe("travel.ts tripUrl/dayUrl — real origin branching", () => {
  const EMBEDDED = "https://kirkl.in";
  const STANDALONE = "https://travel.kirkl.in";

  it("embedded origin gets the /travel-prefixed path", () => {
    expect(tripUrl(EMBEDDED, "T1")).toBe("/travel/T1");
    expect(dayUrl(EMBEDDED, "T1", "2026-06-02")).toBe("/travel/T1/day/2026-06-02");
  });

  it("standalone travel.kirkl.in origin mounts the trip at root (no /travel prefix)", () => {
    expect(tripUrl(STANDALONE, "T1")).toBe("/T1");
    expect(dayUrl(STANDALONE, "T1", "2026-06-02")).toBe("/T1/day/2026-06-02");
  });

  it("legacy empty origin resolves like standalone, not embedded", () => {
    // Pre-migration-0014 subs carry origin="" and were registered on
    // travel.kirkl.in. They must NOT get the /travel prefix.
    expect(tripUrl("", "T1")).toBe("/T1");
    expect(dayUrl("", "T1", "2026-06-02")).toBe("/T1/day/2026-06-02");
  });
});

// Life is standalone-only at life.kirkl.in — the session wizards mount at root
// (/morning, /evening, /weekly). The push must carry a SAME-ORIGIN RELATIVE
// path, never an absolute https://life.kirkl.in/... URL (which would cold-load
// an empty per-origin authStore and present as a forced sign-out).
describe("life.ts sessionUrl — same-origin relative path", () => {
  it("emits a root-relative path for each session kind", () => {
    expect(sessionUrl("morning")).toBe("/morning");
    expect(sessionUrl("evening")).toBe("/evening");
    expect(sessionUrl("weekly")).toBe("/weekly");
  });

  it("never emits an absolute life.kirkl.in URL", () => {
    for (const kind of ["morning", "evening", "weekly"] as const) {
      const url = sessionUrl(kind);
      expect(url.startsWith("/")).toBe(true);
      expect(url).not.toContain("https://life.kirkl.in");
      expect(url).not.toContain("https://");
    }
  });
});

// task_deadline_due taps must open the unified task outliner at /tasks (served
// by the home app at the kirkl.in origin), NOT fall through to the home root /.
describe("deadlines.ts tasksUrl — opens the task outliner", () => {
  it("emits the relative /tasks path", () => {
    expect(tasksUrl()).toBe("/tasks");
  });

  it("is relative (resolves against the delivery origin), not root", () => {
    const url = tasksUrl();
    expect(url.startsWith("/")).toBe(true);
    expect(url).not.toBe("/");
    expect(url).not.toContain("https://");
  });
});

// End-to-end through sendPushToUser: a life morning push delivered to the
// life.kirkl.in subscription carries the relative /morning path, and a
// deadline push carries /tasks — both via buildUrl, matched to the delivery
// origin.
describe("life + deadline buildUrl delivered through sendPushToUser", () => {
  it("life morning push lands a relative /morning, not an absolute URL", async () => {
    const pb = makeFakePb([sub("l1", "https://life.kirkl.in")]);
    await sendPushToUser(
      pb,
      "user1",
      { title: "Morning check-in", buildUrl: () => sessionUrl("morning") },
      { preferredOrigins: ["https://life.kirkl.in", "https://kirkl.in"] },
    );
    const url = pushedUrlFor("https://push.example/l1");
    expect(url).toBe("/morning");
    expect(url).not.toContain("https://life.kirkl.in");
  });

  it("task_deadline_due push lands /tasks, not /", async () => {
    const pb = makeFakePb([sub("d1", "https://kirkl.in")]);
    await sendPushToUser(
      pb,
      "user1",
      { title: "Todo is due", buildUrl: () => tasksUrl() },
      { preferredOrigins: ["https://upkeep.kirkl.in", "https://kirkl.in"] },
    );
    const url = pushedUrlFor("https://push.example/d1");
    expect(url).toBe("/tasks");
    expect(url).not.toBe("/");
  });
});
