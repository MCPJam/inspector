import { LoginRequiredError } from "@workos-inc/authkit-react";
import { describe, expect, it } from "vitest";

import {
  LOGIN_REQUIRED_ERROR_MESSAGE,
  isLoginRequiredError,
} from "../login-required-error";

describe("isLoginRequiredError", () => {
  it("recognizes the error authkit actually throws", () => {
    // The real class, not a hand-written double: this is the test that fails
    // when an authkit release renames the message the matcher depends on.
    // `LoginRequiredError` never assigns `name`, so a real instance arrives
    // as a plain `Error` carrying only the fixed message.
    const error = new LoginRequiredError();
    expect(error.name).toBe("Error");
    expect(error.message).toBe(LOGIN_REQUIRED_ERROR_MESSAGE);
    expect(isLoginRequiredError(error)).toBe(true);
  });

  it("recognizes a name-labelled variant", () => {
    const error = new Error("login required");
    error.name = "LoginRequiredError";
    expect(isLoginRequiredError(error)).toBe(true);
  });

  // Deliberately a substring match, not equality. Missing a real
  // `LoginRequiredError` is the expensive direction: it relabels a dead session
  // as transient, which is the exact bug this module exists to fix. A wrapper
  // that prefixes the message would defeat `===` and silently reintroduce it,
  // so the looser test is the safer one.
  it("still recognizes the error through a wrapper that prefixes the message", () => {
    expect(
      isLoginRequiredError(new Error("Refresh failed: No access token available"))
    ).toBe(true);
  });

  it("leaves transient failures retryable", () => {
    expect(isLoginRequiredError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isLoginRequiredError("No access token available")).toBe(false);
    expect(isLoginRequiredError(null)).toBe(false);
  });
});
