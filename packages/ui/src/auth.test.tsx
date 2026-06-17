/**
 * Tests for shouldClearAuthStore — the decision that governs whether a failed
 * authRefresh tears down the session. The bug it guards against: a bare catch
 * cleared the auth store on ANY failure, so opening the app offline or during a
 * deploy (5xx) instantly logged the user out. Only a genuine 401/403 rejection
 * should clear a valid session; everything else is transient.
 */
import { describe, it, expect } from "vitest";
import { shouldClearAuthStore } from "./auth";

describe("shouldClearAuthStore", () => {
  it("clears on a genuinely-invalid credential (401)", () => {
    expect(shouldClearAuthStore({ status: 401 })).toBe(true);
  });

  it("clears on a forbidden credential (403)", () => {
    expect(shouldClearAuthStore({ status: 403 })).toBe(true);
  });

  it("does NOT clear on a network failure (status 0 — offline)", () => {
    expect(shouldClearAuthStore({ status: 0 })).toBe(false);
  });

  it("does NOT clear on a 5xx (API pod mid-deploy)", () => {
    expect(shouldClearAuthStore({ status: 500 })).toBe(false);
    expect(shouldClearAuthStore({ status: 502 })).toBe(false);
    expect(shouldClearAuthStore({ status: 503 })).toBe(false);
  });

  it("does NOT clear on a 429 (rate limit)", () => {
    expect(shouldClearAuthStore({ status: 429 })).toBe(false);
  });

  it("does NOT clear on errors without a numeric status", () => {
    expect(shouldClearAuthStore(new Error("CORS blip"))).toBe(false);
    expect(shouldClearAuthStore(null)).toBe(false);
    expect(shouldClearAuthStore(undefined)).toBe(false);
    expect(shouldClearAuthStore("string error")).toBe(false);
    expect(shouldClearAuthStore({})).toBe(false);
  });
});
