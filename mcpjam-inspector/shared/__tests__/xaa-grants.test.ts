import { describe, it, expect } from "vitest";
import {
  XAA_DRAFT_VERSION,
  TOKEN_EXCHANGE_GRANT,
  JWT_BEARER_GRANT,
  ID_JAG_TOKEN_TYPE,
  ID_TOKEN_TOKEN_TYPE,
  REFRESH_TOKEN_TOKEN_TYPE,
  ID_JAG_JWT_TYP,
  XAA_IDP_MODES,
  DEFAULT_XAA_IDP_MODE,
  isIdJagTokenType,
} from "../xaa-grants.js";

// These values are wire-format constants pinned to the XAA draft. Locking them
// here catches an accidental edit that would silently break the 3-leg flow.
describe("xaa-grants URN constants", () => {
  it("pins the draft version", () => {
    expect(XAA_DRAFT_VERSION).toBe(
      "draft-ietf-oauth-identity-assertion-authz-grant-04",
    );
  });

  it("exposes the two distinct grant types (leg 2 vs leg 3)", () => {
    expect(TOKEN_EXCHANGE_GRANT).toBe(
      "urn:ietf:params:oauth:grant-type:token-exchange",
    );
    expect(JWT_BEARER_GRANT).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(TOKEN_EXCHANGE_GRANT).not.toBe(JWT_BEARER_GRANT);
  });

  it("exposes the token types", () => {
    expect(ID_JAG_TOKEN_TYPE).toBe("urn:ietf:params:oauth:token-type:id-jag");
    expect(ID_TOKEN_TOKEN_TYPE).toBe(
      "urn:ietf:params:oauth:token-type:id_token",
    );
    expect(REFRESH_TOKEN_TOKEN_TYPE).toBe(
      "urn:ietf:params:oauth:token-type:refresh_token",
    );
  });

  it("pins the id-jag JOSE typ discriminator", () => {
    expect(ID_JAG_JWT_TYP).toBe("oauth-id-jag+jwt");
  });
});

describe("XaaIdpMode axis", () => {
  it("offers exactly mcpjam and external", () => {
    expect(XAA_IDP_MODES).toEqual(["mcpjam", "external"]);
  });

  it("defaults to the built-in test IdP", () => {
    expect(DEFAULT_XAA_IDP_MODE).toBe("mcpjam");
  });
});

describe("isIdJagTokenType", () => {
  it("matches the canonical lowercase value", () => {
    expect(isIdJagTokenType(ID_JAG_TOKEN_TYPE)).toBe(true);
  });

  it("matches case-insensitively (IdP casing varies)", () => {
    expect(
      isIdJagTokenType("urn:ietf:params:oauth:token-type:ID-JAG"),
    ).toBe(true);
  });

  it("rejects other token types and empty input", () => {
    expect(isIdJagTokenType(ID_TOKEN_TOKEN_TYPE)).toBe(false);
    expect(isIdJagTokenType(undefined)).toBe(false);
    expect(isIdJagTokenType(null)).toBe(false);
    expect(isIdJagTokenType("")).toBe(false);
  });
});
