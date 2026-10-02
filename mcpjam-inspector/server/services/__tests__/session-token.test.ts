/**
 * Session Token Service Tests
 *
 * Tests for the session token generation and validation service.
 * This is a critical security component for API authentication.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  generateSessionToken,
  getSessionToken,
  validateToken,
} from "../session-token.js";

describe("session-token service", () => {
  describe("generateSessionToken", () => {
    it("uses and removes the launcher override", () => {
      process.env.MCPJAM_SESSION_TOKEN = "launcher-token-with-enough-entropy";
      expect(generateSessionToken()).toBe("launcher-token-with-enough-entropy");
      expect(process.env.MCPJAM_SESSION_TOKEN).toBeUndefined();
    });
    it.each(["", "short", "a".repeat(24) + "<script>", "a".repeat(24) + "\n"])(
      "rejects malformed overrides without retaining them",
      (value) => {
        process.env.MCPJAM_SESSION_TOKEN = value;
        expect(() => generateSessionToken()).toThrow("MCPJAM_SESSION_TOKEN");
        expect(process.env.MCPJAM_SESSION_TOKEN).toBeUndefined();
      },
    );
    it("generates a 32-character URL-safe token (192 bits)", () => {
      const token = generateSessionToken();

      expect(token).toHaveLength(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });

    it("generates different tokens on each call", () => {
      const token1 = generateSessionToken();
      const token2 = generateSessionToken();

      expect(token1).not.toBe(token2);
    });

    it("stores the generated token for later retrieval", () => {
      const generated = generateSessionToken();
      const retrieved = getSessionToken();

      expect(retrieved).toBe(generated);
    });
  });

  describe("getSessionToken", () => {
    beforeEach(() => {
      // Generate a fresh token for each test
      generateSessionToken();
    });

    it("returns the current session token", () => {
      const token = getSessionToken();

      expect(token).not.toBeNull();
      expect(token).toHaveLength(32);
    });

    it("returns the same token on multiple calls", () => {
      const token1 = getSessionToken();
      const token2 = getSessionToken();

      expect(token1).toBe(token2);
    });
  });

  describe("validateToken", () => {
    let validToken: string;

    beforeEach(() => {
      validToken = generateSessionToken();
    });

    it("returns true for valid token", () => {
      expect(validateToken(validToken)).toBe(true);
    });

    it("returns false for invalid token", () => {
      expect(validateToken("invalid-token")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(validateToken("")).toBe(false);
    });

    it("returns false for token with wrong length", () => {
      // Too short
      expect(validateToken(validToken.slice(0, 16))).toBe(false);
      // Too long
      expect(validateToken(validToken + "extra")).toBe(false);
    });

    it("returns false for token with single character difference", () => {
      // Modify one character
      const invalidToken =
        validToken.charAt(0) === "a"
          ? "b" + validToken.slice(1)
          : "a" + validToken.slice(1);

      expect(validateToken(invalidToken)).toBe(false);
    });

    it("is case sensitive", () => {
      const upperToken = validToken.toUpperCase();

      // Token should be lowercase hex, so uppercase should fail
      expect(validateToken(upperToken)).toBe(false);
    });

    it("handles null-like values safely", () => {
      expect(validateToken(null as unknown as string)).toBe(false);
      expect(validateToken(undefined as unknown as string)).toBe(false);
    });
  });

  describe("security properties", () => {
    it("token has sufficient entropy (256 bits = 64 hex chars)", () => {
      const token = generateSessionToken();

      // 256 bits = 32 bytes = 64 hex characters
      // This provides 2^256 brute force resistance
      expect(token).toHaveLength(32);
    });

    it("tokens are cryptographically random (no obvious patterns)", () => {
      const tokens = Array.from({ length: 10 }, () => generateSessionToken());

      // Check that tokens are all different
      const uniqueTokens = new Set(tokens);
      expect(uniqueTokens.size).toBe(10);

      // Check that no token is a simple pattern
      for (const token of tokens) {
        // Not all same character
        expect(new Set(token.split("")).size).toBeGreaterThan(1);
        // Not sequential
        expect(token).not.toMatch(/^0123456789abcdef/);
      }
    });
  });
});
