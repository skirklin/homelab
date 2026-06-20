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
import { viewUrl } from "./notifications/life";
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

/** Like makeFakePb but records which sub ids had delete() called on them. */
function makeFakePbRecordingDeletes(subs: FakeSub[], deleted: string[]) {
  return {
    filter: (expr: string, _params: Record<string, unknown>) => expr,
    collection() {
      return {
        getFullList: async () => subs,
        delete: async (id: string) => { deleted.push(id); },
      };
    },
  } as never;
}

describe("sendPushToUser — dead-subscription pruning", () => {
  // A VAPID key rotation leaves old subs returning 403 (applicationServerKey
  // mismatch). They can never receive pushes again, so they must be pruned just
  // like 404/410 — otherwise they accumulate and shadow working subs.
  it.each([403, 404, 410])("prunes a sub when web-push rejects with %i", async (statusCode) => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("rejected"), { statusCode }));
    const deleted: string[] = [];
    const pb = makeFakePbRecordingDeletes([sub("dead", "https://kirkl.in")], deleted);

    const result = await sendPushToUser(pb, "user1", { title: "x", url: "/x" });

    expect(deleted).toEqual(["dead"]);
    expect(result.expired).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("does NOT prune on other failures (e.g. 500); counts as failed", async () => {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 500 }));
    const deleted: string[] = [];
    const pb = makeFakePbRecordingDeletes([sub("transient", "https://kirkl.in")], deleted);

    const result = await sendPushToUser(pb, "user1", { title: "x", url: "/x" });

    expect(deleted).toEqual([]);
    expect(result.failed).toBe(1);
    expect(result.expired).toBe(0);
  });
});

/** Return the 3rd (options) arg web-push received for a given endpoint. */
function pushedOptionsFor(endpoint: string): { urgency?: string; TTL?: number } | undefined {
  const call = sendNotification.mock.calls.find(
    ([sub]) => (sub as { endpoint: string }).endpoint === endpoint,
  );
  return call?.[2] as { urgency?: string; TTL?: number } | undefined;
}

// Promptness fix: Android (Doze) defers a "normal"-urgency push until the app
// reopens, and web-push's default 4-week TTL lets a missed push linger absurdly
// late. Every send must carry urgency:"high" + a finite (few-hours) TTL by
// default, with both overridable per call.
describe("sendPushToUser — urgency + TTL options", () => {
  it("defaults to urgency:'high' and a finite TTL", async () => {
    const pb = makeFakePb([sub("o1", "https://kirkl.in")]);
    await sendPushToUser(pb, "user1", { title: "x", url: "/x" });
    const opts = pushedOptionsFor("https://push.example/o1");
    expect(opts?.urgency).toBe("high");
    expect(Number.isFinite(opts?.TTL)).toBe(true);
    expect(opts?.TTL).toBe(14400);
  });

  it("honors an explicit urgency / ttlSeconds override", async () => {
    const pb = makeFakePb([sub("o2", "https://kirkl.in")]);
    await sendPushToUser(
      pb,
      "user1",
      { title: "x", url: "/x" },
      { urgency: "low", ttlSeconds: 60 },
    );
    const opts = pushedOptionsFor("https://push.example/o2");
    expect(opts?.urgency).toBe("low");
    expect(opts?.TTL).toBe(60);
  });
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
describe("life.ts viewUrl — same-origin relative path", () => {
  it("emits a root-relative path for each session kind", () => {
    expect(viewUrl("morning")).toBe("/morning");
    expect(viewUrl("evening")).toBe("/evening");
    expect(viewUrl("weekly")).toBe("/weekly");
  });

  it("never emits an absolute life.kirkl.in URL", () => {
    for (const kind of ["morning", "evening", "weekly"] as const) {
      const url = viewUrl(kind);
      expect(url.startsWith("/")).toBe(true);
      expect(url).not.toContain("https://life.kirkl.in");
      expect(url).not.toContain("https://");
    }
  });
});

// task_attention taps open the unified task outliner at /tasks — but ONLY
// the home app (kirkl.in) serves that route. Standalone upkeep has no /tasks
// route (it would match the `/:slug` catch-all → "list doesn't exist"), so on
// the upkeep origin the link must fall back to `/` (the usable ListPicker).
describe("deadlines.ts tasksUrl — origin-aware task outliner link", () => {
  it("emits /tasks on the home origin (the outliner)", () => {
    expect(tasksUrl("https://kirkl.in")).toBe("/tasks");
  });

  it("emits / on the upkeep origin (no /tasks route there → ListPicker)", () => {
    expect(tasksUrl("https://upkeep.kirkl.in")).toBe("/");
  });

  it("is relative on the home origin, not root", () => {
    const url = tasksUrl("https://kirkl.in");
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
      { title: "Morning check-in", buildUrl: () => viewUrl("morning") },
      { preferredOrigins: ["https://life.kirkl.in", "https://kirkl.in"] },
    );
    const url = pushedUrlFor("https://push.example/l1");
    expect(url).toBe("/morning");
    expect(url).not.toContain("https://life.kirkl.in");
  });

  it("deadline delivered to a kirkl.in sub lands /tasks (the outliner)", async () => {
    const pb = makeFakePb([sub("d1", "https://kirkl.in")]);
    await sendPushToUser(
      pb,
      "user1",
      { title: "Todo is due", buildUrl: (origin) => tasksUrl(origin) },
      { preferredOrigins: ["https://kirkl.in", "https://upkeep.kirkl.in"] },
    );
    const url = pushedUrlFor("https://push.example/d1");
    expect(url).toBe("/tasks");
    expect(url).not.toBe("/");
  });

  // The blocker: a user with ONLY an upkeep.kirkl.in sub (no home sub) must NOT
  // get /tasks — that route doesn't exist on standalone upkeep (dead-end slug
  // page). It must fall back to `/` (the usable ListPicker).
  it("deadline delivered to an upkeep-only sub lands /, not the dead-end /tasks", async () => {
    const pb = makeFakePb([sub("d2", "https://upkeep.kirkl.in")]);
    await sendPushToUser(
      pb,
      "user1",
      { title: "Todo is due", buildUrl: (origin) => tasksUrl(origin) },
      { preferredOrigins: ["https://kirkl.in", "https://upkeep.kirkl.in"] },
    );
    const url = pushedUrlFor("https://push.example/d2");
    expect(url).toBe("/");
    expect(url).not.toBe("/tasks");
  });
});
