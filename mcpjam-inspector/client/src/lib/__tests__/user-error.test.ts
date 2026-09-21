import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../error-messages";
import { getUserErrorMessage } from "../user-error";
import { convexErrMessage } from "../convex-error";

describe("user-facing error messages", () => {
  it.each([
    undefined,
    null,
    "",
    "SQL failure: secret",
    new Error("SQL failure: secret"),
    { data: "SQL failure: secret" },
    { data: { message: "SQL failure: secret" } },
    { message: "SQL failure: secret", code: "toString" },
    { error: "SQL failure: secret" },
  ])("uses safe copy for an unknown failure (%j)", (error) => {
    expect(getUserErrorMessage(error)).toBe(ERROR_MESSAGES.unexpected);
    expect(convexErrMessage(error, ERROR_MESSAGES.failedToCreateSuite)).toBe(
      ERROR_MESSAGES.failedToCreateSuite,
    );
  });

  it("uses the operation fallback without exposing backend text", () => {
    expect(
      getUserErrorMessage(
        new Error("internal detail"),
        ERROR_MESSAGES.connectionFailed,
      ),
    ).toBe(ERROR_MESSAGES.connectionFailed);
  });

  it("does not accept backend text as a fallback", () => {
    expect(getUserErrorMessage(null, "backend secret")).toBe(
      ERROR_MESSAGES.unexpected,
    );
  });

  it("directs provider authentication failures to settings without exposing provider text", () => {
    expect(getUserErrorMessage({ code: "auth_error", message: "secret provider response" }, ERROR_MESSAGES.chatFailed)).toBe(ERROR_MESSAGES.modelProviderAuthenticationFailed);
  });

  it("maps known codes independently of backend wording", () => {
    for (const error of [
      { code: "ENV_NO_SERVERS", message: "private server address" },
      { data: { code: "ENV_NO_SERVERS", message: "private server address" } },
      { code: "conflict", details: { code: "ENV_NO_SERVERS" } },
    ]) {
      expect(getUserErrorMessage(error)).toBe(
        ERROR_MESSAGES.environmentNoServers,
      );
    }
  });

  it("keeps authored catalog guidance from local validation", () => {
    expect(getUserErrorMessage(ERROR_MESSAGES.enterYourName)).toBe(
      ERROR_MESSAGES.enterYourName,
    );
    expect(getUserErrorMessage(new Error(ERROR_MESSAGES.enterYourName))).toBe(
      ERROR_MESSAGES.enterYourName,
    );
  });

  it("handles thrown values with unreadable properties", () => {
    const error = Object.defineProperty({}, "data", {
      get() {
        throw new Error("unreadable");
      },
    });
    expect(getUserErrorMessage(error)).toBe(ERROR_MESSAGES.unexpected);
  });
});
