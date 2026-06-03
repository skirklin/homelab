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
