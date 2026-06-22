/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// getApiBase/getAuthHeaders are pulled from ./api; stub them so the test is
// independent of env/auth wiring.
vi.mock("./api", () => ({
  getApiBase: () => "http://api.test",
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

import { reconcilePushSubscription } from "./push";

// --- Browser-API harness --------------------------------------------------

type SubInit = { userVisibleOnly: boolean; applicationServerKey: BufferSource };

function makeSubscription(applicationServerKey: ArrayBuffer | null, endpoint = "https://push.test/ep") {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  return {
    endpoint,
    options: { applicationServerKey },
    unsubscribe,
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

/**
 * Build a fake navigator.serviceWorker.ready whose pushManager returns
 * `existing` from getSubscription() and records subscribe() calls.
 */
function installServiceWorker(opts: {
  existing: ReturnType<typeof makeSubscription> | null;
}) {
  const subscribe = vi.fn(async (init: SubInit) =>
    makeSubscription(init.applicationServerKey as ArrayBuffer, "https://push.test/new"),
  );
  const getSubscription = vi.fn().mockResolvedValue(opts.existing);
  const registration = { pushManager: { getSubscription, subscribe } };

  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve(registration),
      register: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });

  return { subscribe, getSubscription, registration };
}

function installNotification(permission: NotificationPermission) {
  vi.stubGlobal("Notification", {
    permission,
    requestPermission: vi.fn().mockResolvedValue(permission),
  });
}

function installPushManagerGlobal() {
  // isNotificationSupported() checks for these on window/navigator.
  vi.stubGlobal("PushManager", function () {});
}

// VAPID key the server hands out. urlBase64ToUint8Array of this is what a fresh
// subscription's applicationServerKey will hold.
const VAPID = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function fetchOk() {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/push/vapid-key")) {
      return { ok: true, json: async () => ({ publicKey: VAPID }) } as Response;
    }
    // /push/subscribe
    return { ok: true } as Response;
  });
}

describe("reconcilePushSubscription", () => {
  beforeEach(() => {
    installPushManagerGlobal();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns false (and never subscribes) when permission is not granted", async () => {
    installNotification("default");
    const { subscribe } = installServiceWorker({ existing: null });
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcilePushSubscription();

    expect(result).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("subscribes + POSTs /push/subscribe when granted with no existing sub", async () => {
    installNotification("granted");
    const { subscribe } = installServiceWorker({ existing: null });
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcilePushSubscription();

    expect(result).toBe(true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const postCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/push/subscribe"));
    expect(postCalls).toHaveLength(1);
  });

  it("drops + re-subscribes when the existing sub was created against a different VAPID key", async () => {
    installNotification("granted");
    // Existing sub carries a key that won't match the server's VAPID key.
    const staleKey = new Uint8Array([1, 2, 3]).buffer;
    const existing = makeSubscription(staleKey);
    const { subscribe } = installServiceWorker({ existing });
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcilePushSubscription();

    expect(result).toBe(true);
    // The rotated sub is dropped, then a fresh one is created.
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
