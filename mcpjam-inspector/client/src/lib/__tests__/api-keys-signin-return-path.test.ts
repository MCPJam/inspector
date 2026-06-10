import { afterEach, describe, expect, it } from "vitest";
import {
  clearApiKeysSignInReturnPath,
  readApiKeysSignInReturnPath,
  writeApiKeysSignInReturnPath,
} from "../api-keys-signin-return-path";

describe("api-keys-signin-return-path", () => {
  afterEach(() => {
    clearApiKeysSignInReturnPath();
  });

  it("round-trips the API keys settings route", () => {
    writeApiKeysSignInReturnPath("/settings/api-keys");

    expect(readApiKeysSignInReturnPath()).toBe("/settings/api-keys");
  });

  it("falls back to root for empty or unknown routes", () => {
    writeApiKeysSignInReturnPath("/not-an-app-route");

    expect(readApiKeysSignInReturnPath()).toBe("/");

    clearApiKeysSignInReturnPath();
    writeApiKeysSignInReturnPath("");

    expect(readApiKeysSignInReturnPath()).toBe("/");
  });

  it("clears the stored path", () => {
    writeApiKeysSignInReturnPath("/settings/api-keys");
    clearApiKeysSignInReturnPath();

    expect(readApiKeysSignInReturnPath()).toBeNull();
  });
});
