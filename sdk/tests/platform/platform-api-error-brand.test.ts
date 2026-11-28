import { describe, expect, it } from "vitest";
import {
  isPlatformApiError,
  PlatformApiError,
} from "../../src/platform/errors.js";

describe("isPlatformApiError", () => {
  it("recognizes an error thrown by another bundled copy of the SDK", () => {
    // What a second entry's instance looks like from here: another class, the
    // same global brand.
    const fromOtherBundle = Object.defineProperty(
      new Error("Suite not found"),
      Symbol.for("@mcpjam/sdk/PlatformApiError"),
      { value: true }
    );
    expect(isPlatformApiError(fromOtherBundle)).toBe(true);
    expect(
      isPlatformApiError(
        new PlatformApiError("Suite not found", "NOT_FOUND", { status: 404 })
      )
    ).toBe(true);
  });

  it("rejects an error that only looks like one", () => {
    const lookAlike = Object.assign(new Error("Suite not found"), {
      name: "PlatformApiError",
      status: 404,
      code: "NOT_FOUND",
    });
    expect(isPlatformApiError(lookAlike)).toBe(false);
    expect(isPlatformApiError("NOT_FOUND")).toBe(false);
  });
});
