import { describe, expect, it } from "vitest";
import {
  credentialsFromServerConfig,
  LOGIN_NEEDED_MESSAGE,
  LOGIN_REJECTED_MESSAGE,
  loginRequiredDetails,
  sentCredentials,
} from "../src/conformance-login.js";
import {
  isMissingInputCheck,
  missingInputMessage,
} from "../src/conformance-input.js";
import { isAuthorizationRequiredCheck } from "../src/conformance-authorization.js";

function loginSkip(details: Record<string, unknown>) {
  return {
    id: "tools-list",
    status: "skipped",
    skipReason: "could-not-run",
    details,
  };
}

describe("a 401 is a login to fix, not a server fault", () => {
  it("asks for a login when the run sent no credentials", () => {
    const check = loginSkip(loginRequiredDetails(undefined, undefined));
    expect(isMissingInputCheck(check)).toBe(true);
    expect(isAuthorizationRequiredCheck(check)).toBe(true);
    expect(missingInputMessage(check)).toBe(LOGIN_NEEDED_MESSAGE);
  });

  it("asks to log in again when the run's token was rejected", () => {
    for (const source of [
      { accessToken: "expired" },
      { headers: { Authorization: "Bearer expired" } },
      { refreshToken: "refresh" },
    ]) {
      const check = loginSkip(loginRequiredDetails(undefined, source));
      expect(missingInputMessage(check)).toBe(LOGIN_REJECTED_MESSAGE);
    }
  });

  it("reads credentials from a server config", () => {
    expect(
      sentCredentials(
        credentialsFromServerConfig({
          url: "https://x.test/mcp",
          requestInit: { headers: { authorization: "Bearer t" } },
        })
      )
    ).toBe(true);
    expect(
      sentCredentials(credentialsFromServerConfig({ url: "https://x.test" }))
    ).toBe(false);
    expect(sentCredentials(credentialsFromServerConfig(undefined))).toBe(false);
  });
});
