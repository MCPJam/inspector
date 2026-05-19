import { afterEach, describe, expect, it } from "vitest";
import {
  clearCliSignInReturnPath,
  readCliSignInReturnPath,
  writeCliSignInReturnPath,
} from "../cli-signin-return-path";

describe("cli-signin-return-path", () => {
  afterEach(() => {
    clearCliSignInReturnPath();
  });

  it("round-trips an app route", () => {
    writeCliSignInReturnPath("/tools?server=demo");

    expect(readCliSignInReturnPath()).toBe("/tools?server=demo");
  });

  it("falls back to root for empty or unknown routes", () => {
    writeCliSignInReturnPath("/not-an-app-route");

    expect(readCliSignInReturnPath()).toBe("/");

    clearCliSignInReturnPath();
    writeCliSignInReturnPath("");

    expect(readCliSignInReturnPath()).toBe("/");
  });
});
