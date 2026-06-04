/**
 * E2E coverage for the per-user travel-notes REST surface (Phase 3):
 *   GET    /data/travel/notes?log=&subject_type=&subject_id=
 *   POST   /data/travel/notes
 *   PATCH  /data/travel/notes/:noteId
 *   DELETE /data/travel/notes/:noteId
 *
 * The api service talks to PB through the admin client, which BYPASSES PB
 * collection rules — so route-layer `userOwnsTravelLog` is the only thing
 * standing between an `hlk_`/`mcpat_` token holder and a cross-tenant note
 * write. These tests pin that gate plus the server-side `created_by` stamp.
 *
 * Security invariants under test:
 *   - POST stamps created_by = caller's userId; a client-supplied created_by
 *     in the body is IGNORED (never trust the author claim).
 *   - PATCH cannot change created_by / subject_* — entries-only.
 *   - A non-owner (different log) is denied list/POST/PATCH/DELETE.
 *   - subject_type is validated against {activity|day|trip}; garbage rejected.
 *   - Happy path round-trips: create → list → update → delete.
 *
 * Requires `pnpm test:env:up`.
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

interface Actor {
  id: string;
  email: string;
  userJwt: string;
  apiToken: string;
}

let adminPb: PocketBase;
let alice: Actor; // non-owner attacker
let bob: Actor; // owns the log
let bobsLogId: string;
let bobsTripId: string;
let bobsActivityId: string;

async function makeActor(suffix: string): Promise<Actor> {
  const email = `${suffix}-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = "testpassword123";
  const user = await adminPb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name: suffix,
  });
  const userPb = new PocketBase(PB_URL);
  userPb.autoCancellation(false);
  await userPb.collection("users").authWithPassword(email, password);

  const tokenResp = await app.request("/auth/tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userPb.authStore.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: `${suffix}-test-token` }),
  });
  const tokenData = await tokenResp.json() as { token: string };

  return {
    id: user.id,
    email,
    userJwt: userPb.authStore.token,
    apiToken: tokenData.token,
  };
}

async function apiReq(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; data: unknown }> {
  const resp = await app.request(path, {
    method: opts.method || "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: resp.status, data: await resp.json().catch(() => null) };
}

beforeAll(async () => {
  adminPb = new PocketBase(PB_URL);
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword(
    "test-admin@test.local",
    "testpassword1234",
  );

  alice = await makeActor("alice-notes");
  bob = await makeActor("bob-notes");

  const bobPb = new PocketBase(PB_URL);
  bobPb.autoCancellation(false);
  bobPb.authStore.save(bob.userJwt, null);

  const bobsLog = await bobPb.collection("travel_logs").create({
    name: "Bob's notes log",
    owners: [bob.id],
  });
  bobsLogId = bobsLog.id;

  const bobsTrip = await bobPb.collection("travel_trips").create({
    log: bobsLogId,
    destination: "Bob's trip",
    status: "Booked",
  });
  bobsTripId = bobsTrip.id;

  const bobsActivity = await bobPb.collection("travel_activities").create({
    log: bobsLogId,
    name: "Bob's activity",
    trip_id: bobsTripId,
  });
  bobsActivityId = bobsActivity.id;
});

describe("travel notes — happy path round-trip (owner)", () => {
  let noteId: string;

  it("POST creates a note and stamps created_by = caller", async () => {
    const { status, data } = await apiReq("/data/travel/notes", {
      method: "POST",
      token: bob.apiToken,
      body: {
        log: bobsLogId,
        subject_type: "activity",
        subject_id: bobsActivityId,
        entries: [{ name: "notes", type: "text", value: "Loved this spot" }],
      },
    });
    expect(status).toBe(201);
    const note = data as { id: string; created_by: string };
    expect(note.id).toBeTruthy();
    expect(note.created_by).toBe(bob.id);
    noteId = note.id;
  });

  it("GET lists the note for its subject", async () => {
    const { status, data } = await apiReq(
      `/data/travel/notes?log=${bobsLogId}&subject_type=activity&subject_id=${bobsActivityId}`,
      { token: bob.apiToken },
    );
    expect(status).toBe(200);
    const notes = data as Array<{ id: string; created_by: string; entries: unknown[] }>;
    expect(notes.length).toBe(1);
    expect(notes[0].id).toBe(noteId);
    expect(notes[0].created_by).toBe(bob.id);
    expect(notes[0].entries).toEqual([{ name: "notes", type: "text", value: "Loved this spot" }]);
  });

  it("PATCH replaces entries wholesale", async () => {
    const { status, data } = await apiReq(`/data/travel/notes/${noteId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: { entries: [{ name: "notes", type: "text", value: "Updated note" }] },
    });
    expect(status).toBe(200);
    const note = data as { entries: unknown[] };
    expect(note.entries).toEqual([{ name: "notes", type: "text", value: "Updated note" }]);
  });

  it("DELETE removes the note", async () => {
    const { status } = await apiReq(`/data/travel/notes/${noteId}`, {
      method: "DELETE",
      token: bob.apiToken,
    });
    expect(status).toBe(200);
    const { data } = await apiReq(
      `/data/travel/notes?log=${bobsLogId}&subject_type=activity&subject_id=${bobsActivityId}`,
      { token: bob.apiToken },
    );
    expect((data as unknown[]).length).toBe(0);
  });
});

describe("travel notes — created_by cannot be spoofed", () => {
  it("ignores a client-supplied created_by in the POST body", async () => {
    const { status, data } = await apiReq("/data/travel/notes", {
      method: "POST",
      token: bob.apiToken,
      body: {
        log: bobsLogId,
        subject_type: "trip",
        subject_id: bobsTripId,
        created_by: alice.id, // attempt to forge authorship
        entries: [{ name: "notes", type: "text", value: "forged?" }],
      },
    });
    expect(status).toBe(201);
    const note = data as { id: string; created_by: string };
    // Server stamps the real caller, NOT the forged value.
    expect(note.created_by).toBe(bob.id);
    expect(note.created_by).not.toBe(alice.id);

    // Confirm in PB directly.
    const rec = await adminPb.collection("travel_notes").getOne(note.id);
    expect(rec.created_by).toBe(bob.id);
  });

  it("PATCH cannot change created_by or subject_*", async () => {
    const created = await apiReq("/data/travel/notes", {
      method: "POST",
      token: bob.apiToken,
      body: {
        log: bobsLogId,
        subject_type: "trip",
        subject_id: bobsTripId,
        entries: [{ name: "notes", type: "text", value: "original" }],
      },
    });
    const noteId = (created.data as { id: string }).id;

    const { status } = await apiReq(`/data/travel/notes/${noteId}`, {
      method: "PATCH",
      token: bob.apiToken,
      body: {
        created_by: alice.id,
        subject_type: "activity",
        subject_id: bobsActivityId,
        log: bobsLogId,
        entries: [{ name: "notes", type: "text", value: "patched" }],
      },
    });
    expect(status).toBe(200);

    const rec = await adminPb.collection("travel_notes").getOne(noteId);
    expect(rec.created_by).toBe(bob.id);
    expect(rec.subject_type).toBe("trip");
    expect(rec.subject_id).toBe(bobsTripId);
  });
});

describe("travel notes — subject_type validation", () => {
  it("rejects a garbage subject_type", async () => {
    const { status } = await apiReq("/data/travel/notes", {
      method: "POST",
      token: bob.apiToken,
      body: {
        log: bobsLogId,
        subject_type: "spaceship",
        subject_id: bobsTripId,
        entries: [{ name: "notes", type: "text", value: "nope" }],
      },
    });
    expect(status).toBe(400);
  });

  it("rejects malformed entries", async () => {
    const { status } = await apiReq("/data/travel/notes", {
      method: "POST",
      token: bob.apiToken,
      body: {
        log: bobsLogId,
        subject_type: "trip",
        subject_id: bobsTripId,
        entries: [{ name: "notes", type: "banana", value: "nope" }],
      },
    });
    expect(status).toBe(400);
  });
});

describe("travel notes — cross-tenant denial (admin-PB bypass)", () => {
  let bobsNoteId: string;

  beforeAll(async () => {
    const { data } = await apiReq("/data/travel/notes", {
      method: "POST",
      token: bob.apiToken,
      body: {
        log: bobsLogId,
        subject_type: "activity",
        subject_id: bobsActivityId,
        entries: [{ name: "notes", type: "text", value: "Bob's private note" }],
      },
    });
    bobsNoteId = (data as { id: string }).id;
  });

  it("blocks Alice from POSTing a note into Bob's log", async () => {
    const { status } = await apiReq("/data/travel/notes", {
      method: "POST",
      token: alice.apiToken,
      body: {
        log: bobsLogId,
        subject_type: "activity",
        subject_id: bobsActivityId,
        entries: [{ name: "notes", type: "text", value: "phantom" }],
      },
    });
    expect(status, "Alice wrote a note into Bob's log").toBe(403);
  });

  it("blocks Alice from listing notes in Bob's log", async () => {
    const { status } = await apiReq(
      `/data/travel/notes?log=${bobsLogId}&subject_type=activity&subject_id=${bobsActivityId}`,
      { token: alice.apiToken },
    );
    expect(status, "Alice read notes in Bob's log").toBe(403);
  });

  it("blocks Alice from PATCHing Bob's note", async () => {
    const { status } = await apiReq(`/data/travel/notes/${bobsNoteId}`, {
      method: "PATCH",
      token: alice.apiToken,
      body: { entries: [{ name: "notes", type: "text", value: "hijacked" }] },
    });
    expect(status, "Alice edited Bob's note").toBe(403);
    // And Bob's note is untouched.
    const rec = await adminPb.collection("travel_notes").getOne(bobsNoteId);
    expect((rec.entries as Array<{ value: string }>)[0].value).toBe("Bob's private note");
  });

  it("blocks Alice from DELETEing Bob's note", async () => {
    const { status } = await apiReq(`/data/travel/notes/${bobsNoteId}`, {
      method: "DELETE",
      token: alice.apiToken,
    });
    expect(status, "Alice deleted Bob's note").toBe(403);
    // Still there.
    const rec = await adminPb.collection("travel_notes").getOne(bobsNoteId);
    expect(rec.id).toBe(bobsNoteId);
  });
});
