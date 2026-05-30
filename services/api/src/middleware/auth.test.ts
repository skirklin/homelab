/**
 * Unit tests for the auth middleware's error classifier.
 *
 * The classifier decides whether a thrown error during token validation
 * means "this token is genuinely invalid" (→ 401) or "the PocketBase
 * backend is unreachable / erroring" (→ 503). Misclassifying the latter
 * as a 401 is what caused the event-watcher to page during a PB rollout.
 */
import { describe, it, expect } from "vitest";
import { ClientResponseError } from "pocketbase";
import { isBackendUnavailable } from "./auth";

describe("isBackendUnavailable", () => {
  it("treats a status-0 ClientResponseError (network failure) as backend-unavailable", () => {
    const err = new ClientResponseError({ status: 0, response: {}, isAbort: false });
    expect(isBackendUnavailable(err)).toBe(true);
  });

  it("treats a 5xx ClientResponseError (PB erroring) as backend-unavailable", () => {
    const err = new ClientResponseError({ status: 503, response: {}, isAbort: false });
    expect(isBackendUnavailable(err)).toBe(true);
    const err500 = new ClientResponseError({ status: 500, response: {}, isAbort: false });
    expect(isBackendUnavailable(err500)).toBe(true);
  });

  it("treats a 404 ClientResponseError (token not found) as a genuine auth failure", () => {
    const err = new ClientResponseError({ status: 404, response: {}, isAbort: false });
    expect(isBackendUnavailable(err)).toBe(false);
  });

  it("treats a 4xx ClientResponseError (forbidden / bad request) as a genuine auth failure", () => {
    const err400 = new ClientResponseError({ status: 400, response: {}, isAbort: false });
    expect(isBackendUnavailable(err400)).toBe(false);
    const err403 = new ClientResponseError({ status: 403, response: {}, isAbort: false });
    expect(isBackendUnavailable(err403)).toBe(false);
  });

  it("treats a plain Error (undici/fetch network error, getAdminPb admin-auth failure) as backend-unavailable", () => {
    expect(isBackendUnavailable(new Error("fetch failed"))).toBe(true);
    expect(isBackendUnavailable(new Error("PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD must be set"))).toBe(true);
  });

  it("treats unknown thrown values as backend-unavailable", () => {
    expect(isBackendUnavailable("boom")).toBe(true);
    expect(isBackendUnavailable(undefined)).toBe(true);
  });
});
