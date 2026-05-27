/**
 * Regression test for PocketBase filter injection on
 * GET /data/travel/trips?log=&status=.
 *
 * The old route built its filter via string interpolation:
 *
 *     let filter = pb.filter("log = {:logId}", { logId });
 *     if (status) filter += ` && status = "${status}"`;
 *
 * That let a caller close the quoted status clause and OR-in additional
 * filter terms. Because PB's `&&` binds tighter than `||`, the injection
 *
 *     status=Booked" || status="Completed
 *
 * expanded to
 *
 *     log = "alice" && status = "Booked" || status = "Completed"
 *
 * which evaluates as `(log=alice && status=Booked) || status=Completed`
 * — returning every Completed trip Alice could see, ignoring the `log`
 * scoping that was supposed to bound the query.
 *
 * Requires `pnpm test:env:up` (PB on 8091).
 */
import { describe, it, expect, beforeAll } from "vitest";
import PocketBase from "pocketbase";
import { randomBytes } from "crypto";
import { getPbTestUrl } from "./pb-test-url";

process.env.PB_URL = getPbTestUrl();
process.env.PB_ADMIN_EMAIL = "test-admin@test.local";
process.env.PB_ADMIN_PASSWORD = "testpassword1234";

const { default: { app } } = await import("../test-app");

const PB_URL = getPbTestUrl();

let userToken: string;
let userId: string;
let aliceLogId: string;

beforeAll(async () => {
  const adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  const email = `alice-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: "Alice",
  });
  userId = user.id;

  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);
  userToken = userPb.authStore.token;

  const log = await userPb.collection("travel_logs").create({
    name: "Alice's log",
    owners: [userId],
  });
  aliceLogId = log.id;

  // Three trips, one of each status we'll exercise in the test.
  await userPb.collection("travel_trips").create({
    log: log.id,
    destination: "Paris",
    status: "Booked",
  });
  await userPb.collection("travel_trips").create({
    log: log.id,
    destination: "Rome",
    status: "Completed",
  });
  await userPb.collection("travel_trips").create({
    log: log.id,
    destination: "London",
    status: "Researching",
  });
});

async function apiReq(path: string, token: string): Promise<{ status: number; data: unknown }> {
  const resp = await app.request(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: resp.status, data: await resp.json() };
}

describe("filter injection on /data/travel/trips", () => {
  it("control: legitimate status=Booked returns exactly the Booked trip", async () => {
    const { status, data } = await apiReq(
      `/data/travel/trips?log=${aliceLogId}&status=Booked`,
      userToken,
    );
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    const trips = data as Array<{ status: string; destination: string }>;
    expect(trips).toHaveLength(1);
    expect(trips[0].status).toBe("Booked");
    expect(trips[0].destination).toBe("Paris");
  });

  it("injection: status with embedded '|| status=' does NOT broaden results", async () => {
    // Pre-fix: returns both Booked (Paris) and Completed (Rome) because the
    // injected ' || status="Completed"' clause escapes the AND-scope.
    // Post-fix: the entire injected string is the literal status value, so
    // PB matches zero trips (or returns a 4xx).
    const injection = 'Booked" || status="Completed';
    const { status, data } = await apiReq(
      `/data/travel/trips?log=${aliceLogId}&status=${encodeURIComponent(injection)}`,
      userToken,
    );
    expect(status).toBeLessThan(500);

    const trips = Array.isArray(data) ? (data as Array<{ status: string }>) : [];
    // The smoking gun: pre-fix, this list includes a status="Completed" trip
    // that the caller's status filter should not have matched.
    const completedLeaked = trips.find((t) => t.status === "Completed");
    expect(completedLeaked, "filter injection leaked a Completed trip").toBeUndefined();
  });
});
