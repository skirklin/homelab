import { describe, expect, it } from "vitest";
import { takeFlag, takeOpt } from "./cli";

describe("takeOpt", () => {
  it("consumes the option and its value", () => {
    const argv = ["--log", "abc123", "--apply"];
    expect(takeOpt(argv, "--log")).toBe("abc123");
    expect(argv).toEqual(["--apply"]);
  });

  it("returns undefined when absent", () => {
    const argv = ["--apply"];
    expect(takeOpt(argv, "--log")).toBeUndefined();
    expect(argv).toEqual(["--apply"]);
  });

  it("throws when the option is the last arg (no value)", () => {
    expect(() => takeOpt(["--apply", "--log"], "--log")).toThrow("--log requires a value");
  });

  it("throws when the option is followed by another flag", () => {
    expect(() => takeOpt(["--log", "--apply"], "--log")).toThrow("--log requires a value");
  });
});

describe("takeFlag", () => {
  it("consumes a present flag", () => {
    const argv = ["--apply", "rest"];
    expect(takeFlag(argv, "--apply")).toBe(true);
    expect(argv).toEqual(["rest"]);
  });

  it("returns false when absent", () => {
    const argv = ["rest"];
    expect(takeFlag(argv, "--apply")).toBe(false);
    expect(argv).toEqual(["rest"]);
  });
});
