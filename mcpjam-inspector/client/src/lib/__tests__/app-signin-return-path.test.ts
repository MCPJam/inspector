import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_SIGN_IN_RETURN_PATH_TTL_MS,
  captureAppSignInReturnPath,
  clearAppSignInReturnPath,
  consumeAppSignInReturnPath,
  readAppSignInReturnPath,
  writeAppSignInReturnPath,
} from "../app-signin-return-path";

const A = "k5700000000000000000000000a";
const NOW = 1_700_000_000_000;

describe("generic app sign-in return path", () => {
  beforeEach(() => {
    clearAppSignInReturnPath();
  });

  it("restores the COMPLETE canonical URL, project segment and all", () => {
    // Postcondition 7: signing in from a project link returns to that link,
    // not to the app's front door with a project resolved from storage.
    writeAppSignInReturnPath(`/p/${A}/evals/suite/s1?view=runs#case-3`, NOW);
    expect(readAppSignInReturnPath(NOW)).toBe(
      `/p/${A}/evals/suite/s1?view=runs#case-3`
    );
  });

  it("captures path, search and hash from the current location", () => {
    window.history.replaceState({}, "", `/p/${A}/servers?a=1#b`);
    captureAppSignInReturnPath();
    expect(readAppSignInReturnPath()).toBe(`/p/${A}/servers?a=1#b`);
  });

  it("is consumed exactly once", () => {
    // A path left in storage outlives this sign-in and hijacks the next one.
    writeAppSignInReturnPath("/servers", NOW);
    expect(consumeAppSignInReturnPath(NOW)).toBe("/servers");
    expect(consumeAppSignInReturnPath(NOW)).toBeNull();
  });

  it("expires", () => {
    writeAppSignInReturnPath("/servers", NOW);
    expect(readAppSignInReturnPath(NOW + APP_SIGN_IN_RETURN_PATH_TTL_MS - 1)).toBe(
      "/servers"
    );
    expect(
      readAppSignInReturnPath(NOW + APP_SIGN_IN_RETURN_PATH_TTL_MS + 1)
    ).toBeNull();
  });

  it("refuses anything that could leave this origin", () => {
    for (const hostile of [
      "https://evil.example/servers",
      "//evil.example/servers",
      "javascript:alert(1)",
      "/\\evil.example",
    ]) {
      writeAppSignInReturnPath(hostile, NOW);
      expect(readAppSignInReturnPath(NOW), hostile).toBeNull();
    }
  });

  it("refuses a stored value rewritten after the fact", () => {
    // sessionStorage is writable by anything on the origin, so the value is
    // re-validated on the way OUT, not only on the way in.
    writeAppSignInReturnPath("/servers", NOW);
    sessionStorage.setItem(
      "mcpjam_app_signin_return_path_v1",
      JSON.stringify({ path: "https://evil.example", storedAt: NOW })
    );
    expect(readAppSignInReturnPath(NOW)).toBeNull();
  });

  it("does not store the sign-in entry points themselves", () => {
    // Restoring one of these would loop the user back into the flow they
    // just completed.
    for (const path of ["/callback", "/login", "/oauth/callback/debug", "/", "/?x=1"]) {
      writeAppSignInReturnPath(path, NOW);
      expect(readAppSignInReturnPath(NOW), path).toBeNull();
    }
  });

  it("survives a corrupt or legacy stored value", () => {
    sessionStorage.setItem("mcpjam_app_signin_return_path_v1", "not json");
    expect(readAppSignInReturnPath(NOW)).toBeNull();
    sessionStorage.setItem("mcpjam_app_signin_return_path_v1", '"/servers"');
    expect(readAppSignInReturnPath(NOW)).toBeNull();
  });
});
