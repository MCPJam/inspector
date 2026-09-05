import { describe, expect, it } from "vitest";

import { isLoginRequiredError } from "../login-required-error";

describe("isLoginRequiredError", () => {
  it("recognizes the error authkit actually throws", () => {
    // authkit's `LoginRequiredError` never assigns `name`, so a real instance
    // arrives as a plain `Error` carrying only the fixed message.
    const error = new Error("No access token available");
    expect(error.name).toBe("Error");
    expect(isLoginRequiredError(error)).toBe(true);
  });

  it("recognizes a name-labelled variant", () => {
    const error = new Error("login required");
    error.name = "LoginRequiredError";
    expect(isLoginRequiredError(error)).toBe(true);
  });

  it("leaves transient failures retryable", () => {
    expect(isLoginRequiredError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isLoginRequiredError("No access token available")).toBe(false);
    expect(isLoginRequiredError(null)).toBe(false);
  });
});
