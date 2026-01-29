/**
 * Tests for localStorage migration path (name-keyed → ID-keyed storage)
 * and the dual-write / read-with-fallback patterns.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getStoredTokens,
  hasOAuthConfig,
  clearOAuthData,
} from "../mcp-oauth.js";

const SERVER_ID = "uuid-abc-123";
const SERVER_NAME = "My Server";

const sampleTokens = {
  access_token: "at_123",
  refresh_token: "rt_456",
  token_type: "bearer",
};

const sampleClient = {
  client_id: "cid_789",
  client_secret: "secret",
};

beforeEach(() => {
  localStorage.clear();
});

describe("readWithMigration (tested via getStoredTokens)", () => {
  it("reads from ID-keyed storage", () => {
    localStorage.setItem(`mcp-tokens-${SERVER_ID}`, JSON.stringify(sampleTokens));
    const result = getStoredTokens(SERVER_ID, SERVER_NAME);
    expect(result).toMatchObject({ access_token: "at_123" });
  });

  it("falls back to name-keyed storage when ID key is missing", () => {
    localStorage.setItem(`mcp-tokens-${SERVER_NAME}`, JSON.stringify(sampleTokens));
    const result = getStoredTokens(SERVER_ID, SERVER_NAME);
    expect(result).toMatchObject({ access_token: "at_123" });
  });

  it("auto-migrates name-keyed data to ID key on read", () => {
    localStorage.setItem(`mcp-tokens-${SERVER_NAME}`, JSON.stringify(sampleTokens));
    getStoredTokens(SERVER_ID, SERVER_NAME);
    // After reading, the ID key should now exist
    expect(localStorage.getItem(`mcp-tokens-${SERVER_ID}`)).toBe(
      JSON.stringify(sampleTokens),
    );
  });

  it("prefers ID-keyed data over name-keyed data", () => {
    localStorage.setItem(`mcp-tokens-${SERVER_ID}`, JSON.stringify({ ...sampleTokens, access_token: "id_token" }));
    localStorage.setItem(`mcp-tokens-${SERVER_NAME}`, JSON.stringify({ ...sampleTokens, access_token: "name_token" }));
    const result = getStoredTokens(SERVER_ID, SERVER_NAME);
    expect(result.access_token).toBe("id_token");
  });

  it("returns undefined when neither key exists", () => {
    expect(getStoredTokens(SERVER_ID, SERVER_NAME)).toBeUndefined();
  });

  it("returns undefined when serverName is not provided and ID key is missing", () => {
    localStorage.setItem(`mcp-tokens-${SERVER_NAME}`, JSON.stringify(sampleTokens));
    // Without serverName, can't fall back
    expect(getStoredTokens(SERVER_ID)).toBeUndefined();
  });

  it("merges client_id from client info into tokens", () => {
    localStorage.setItem(`mcp-tokens-${SERVER_ID}`, JSON.stringify(sampleTokens));
    localStorage.setItem(`mcp-client-${SERVER_ID}`, JSON.stringify(sampleClient));
    const result = getStoredTokens(SERVER_ID, SERVER_NAME);
    expect(result.client_id).toBe("cid_789");
  });
});

describe("hasOAuthConfig (tests readWithMigration for multiple prefixes)", () => {
  it("detects config from ID-keyed storage", () => {
    localStorage.setItem(`mcp-serverUrl-${SERVER_ID}`, "https://example.com");
    localStorage.setItem(`mcp-client-${SERVER_ID}`, JSON.stringify(sampleClient));
    expect(hasOAuthConfig(SERVER_ID, SERVER_NAME)).toBe(true);
  });

  it("detects config from name-keyed storage (migration fallback)", () => {
    localStorage.setItem(`mcp-serverUrl-${SERVER_NAME}`, "https://example.com");
    localStorage.setItem(`mcp-client-${SERVER_NAME}`, JSON.stringify(sampleClient));
    expect(hasOAuthConfig(SERVER_ID, SERVER_NAME)).toBe(true);
  });

  it("returns false when no config exists", () => {
    expect(hasOAuthConfig(SERVER_ID, SERVER_NAME)).toBe(false);
  });
});

describe("clearOAuthData (tests removeWithLegacy)", () => {
  it("removes both ID-keyed and name-keyed entries", () => {
    const prefixes = ["mcp-tokens", "mcp-client", "mcp-verifier", "mcp-serverUrl", "mcp-oauth-config"];
    for (const prefix of prefixes) {
      localStorage.setItem(`${prefix}-${SERVER_ID}`, "data");
      localStorage.setItem(`${prefix}-${SERVER_NAME}`, "data");
    }

    clearOAuthData(SERVER_ID, SERVER_NAME);

    for (const prefix of prefixes) {
      expect(localStorage.getItem(`${prefix}-${SERVER_ID}`)).toBeNull();
      expect(localStorage.getItem(`${prefix}-${SERVER_NAME}`)).toBeNull();
    }
  });

  it("handles missing name gracefully", () => {
    localStorage.setItem(`mcp-tokens-${SERVER_ID}`, "data");
    clearOAuthData(SERVER_ID);
    expect(localStorage.getItem(`mcp-tokens-${SERVER_ID}`)).toBeNull();
  });
});
