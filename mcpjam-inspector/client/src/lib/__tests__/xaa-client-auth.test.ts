import { describe, expect, it } from "vitest";
import {
  DEFAULT_XAA_CLIENT_AUTH,
  XAA_CLIENT_AUTH_METHODS,
  normalizeXaaClientAuth,
} from "@/shared/xaa.js";

// The CIMD client-auth value round-trips through per-server persistence and
// project import/export, so a regression here silently drops a confidential
// selection back to public. These pins guard the normalize-or-clear boundary.
describe("normalizeXaaClientAuth", () => {
  it("accepts both known methods verbatim", () => {
    expect(normalizeXaaClientAuth("none")).toBe("none");
    expect(normalizeXaaClientAuth("private_key_jwt")).toBe("private_key_jwt");
  });

  it("defaults to the public method", () => {
    expect(DEFAULT_XAA_CLIENT_AUTH).toBe("none");
    expect(XAA_CLIENT_AUTH_METHODS).toEqual(["none", "private_key_jwt"]);
  });

  it.each([
    undefined,
    null,
    "",
    "private-key-jwt", // dash form is CLI-only, not a stored value
    "client_secret_post",
    "PRIVATE_KEY_JWT",
    42,
    {},
  ])("normalizes an unknown/invalid value (%p) to undefined", (value) => {
    expect(normalizeXaaClientAuth(value as unknown)).toBeUndefined();
  });
});
