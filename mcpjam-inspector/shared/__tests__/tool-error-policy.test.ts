import { describe, expect, it } from "vitest";
import { failsOnToolError, withFailOnToolError } from "../tool-error-policy";

describe("failsOnToolError", () => {
  it("is on unless the case stores false", () => {
    expect(failsOnToolError(undefined)).toBe(true);
    expect(failsOnToolError({})).toBe(true);
    expect(failsOnToolError({ failOnToolError: true })).toBe(true);
    expect(failsOnToolError({ failOnToolError: "false" })).toBe(true);
    expect(failsOnToolError({ failOnToolError: false })).toBe(false);
  });
});

describe("withFailOnToolError", () => {
  it("stores false beside the case's other settings", () => {
    expect(withFailOnToolError(undefined, false)).toEqual({
      failOnToolError: false,
    });
    expect(withFailOnToolError({ temperature: 0.2 }, false)).toEqual({
      temperature: 0.2,
      failOnToolError: false,
    });
  });

  it("drops the key when turned back on", () => {
    expect(
      withFailOnToolError({ temperature: 0.2, failOnToolError: false }, true),
    ).toEqual({ temperature: 0.2 });
    expect(
      withFailOnToolError({ failOnToolError: false }, true),
    ).toBeUndefined();
    expect(withFailOnToolError(undefined, true)).toBeUndefined();
  });
});
