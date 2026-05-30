import { describe, it, expect } from "vitest";
import { isTransientStatus } from "./classify";

describe("isTransientStatus", () => {
  it("treats network failures (status 0) as transient", () => {
    expect(isTransientStatus(0)).toBe(true);
  });

  it("treats gateway / service-unavailable responses as transient", () => {
    expect(isTransientStatus(502)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(504)).toBe(true);
  });

  it("treats genuine auth/permission failures as NOT transient", () => {
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(403)).toBe(false);
    expect(isTransientStatus(400)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
  });

  it("treats other server errors (500) as NOT transient (still alertable)", () => {
    // A bare 500 from the api isn't the deploy-blip signal; only the explicit
    // gateway/unavailable codes are. Keep 500 in the alertable bucket.
    expect(isTransientStatus(500)).toBe(false);
  });

  it("treats success codes as NOT transient", () => {
    expect(isTransientStatus(200)).toBe(false);
  });
});
