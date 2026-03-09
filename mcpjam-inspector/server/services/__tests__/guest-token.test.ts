/**
 * Guest Token Service Tests
 *
 * Tests for the HMAC-signed stateless guest token service.
 * Covers token generation, validation, expiry, and tamper resistance.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  initGuestTokenSecret,
  issueGuestToken,
  validateGuestToken,
} from "../guest-token.js";

describe("guest-token service", () => {
  beforeEach(() => {
    // Ensure a fresh secret for each test
    initGuestTokenSecret();
  });

  describe("initGuestTokenSecret", () => {
    afterEach(() => {
      delete process.env.GUEST_TOKEN_SECRET;
    });

    it("generates a random secret when env var is not set", () => {
      delete process.env.GUEST_TOKEN_SECRET;
      initGuestTokenSecret();

      // Should still be able to issue and validate tokens
      const { token } = issueGuestToken();
      const result = validateGuestToken(token);
      expect(result.valid).toBe(true);
    });

    it("uses GUEST_TOKEN_SECRET env var when provided", () => {
      const hexSecret =
        "a".repeat(64); // 32 bytes in hex
      process.env.GUEST_TOKEN_SECRET = hexSecret;
      initGuestTokenSecret();

      const { token } = issueGuestToken();
      const result = validateGuestToken(token);
      expect(result.valid).toBe(true);
    });

    it("tokens from different secrets are incompatible", () => {
      initGuestTokenSecret();
      const { token: token1 } = issueGuestToken();

      // Re-initialize with a new random secret
      initGuestTokenSecret();
      const result = validateGuestToken(token1);
      expect(result.valid).toBe(false);
    });
  });

  describe("issueGuestToken", () => {
    it("returns a guestId, token, and expiresAt", () => {
      const result = issueGuestToken();

      expect(result.guestId).toBeDefined();
      expect(typeof result.guestId).toBe("string");
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe("string");
      expect(result.expiresAt).toBeDefined();
      expect(typeof result.expiresAt).toBe("number");
    });

    it("returns a UUID guestId", () => {
      const { guestId } = issueGuestToken();

      // UUID v4 format
      expect(guestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("generates unique guestIds each call", () => {
      const ids = Array.from({ length: 10 }, () => issueGuestToken().guestId);
      const unique = new Set(ids);
      expect(unique.size).toBe(10);
    });

    it("sets expiresAt approximately 24 hours from now", () => {
      const before = Date.now();
      const { expiresAt } = issueGuestToken();
      const after = Date.now();

      const expectedMin = before + 24 * 60 * 60 * 1000;
      const expectedMax = after + 24 * 60 * 60 * 1000;

      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it("token has two dot-separated parts (payload.signature)", () => {
      const { token } = issueGuestToken();

      const parts = token.split(".");
      expect(parts.length).toBe(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it("payload decodes to valid JSON with expected fields", () => {
      const { token, guestId } = issueGuestToken();

      const [encodedPayload] = token.split(".");
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf-8"),
      );

      expect(payload.guestId).toBe(guestId);
      expect(typeof payload.iat).toBe("number");
      expect(typeof payload.exp).toBe("number");
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });
  });

  describe("validateGuestToken", () => {
    it("validates a freshly issued token", () => {
      const { token, guestId } = issueGuestToken();
      const result = validateGuestToken(token);

      expect(result.valid).toBe(true);
      expect(result.guestId).toBe(guestId);
    });

    it("returns invalid for empty string", () => {
      const result = validateGuestToken("");
      expect(result.valid).toBe(false);
      expect(result.guestId).toBeUndefined();
    });

    it("returns invalid for random string without dots", () => {
      const result = validateGuestToken("not-a-valid-token");
      expect(result.valid).toBe(false);
    });

    it("returns invalid for token with too many parts", () => {
      const result = validateGuestToken("a.b.c");
      expect(result.valid).toBe(false);
    });

    it("returns invalid for token with single part", () => {
      const result = validateGuestToken("singlepart");
      expect(result.valid).toBe(false);
    });

    it("returns invalid for tampered payload", () => {
      const { token } = issueGuestToken();
      const [encodedPayload, signature] = token.split(".");

      // Decode, tamper, re-encode
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf-8"),
      );
      payload.guestId = "tampered-id";
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );

      const result = validateGuestToken(`${tamperedPayload}.${signature}`);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for tampered signature", () => {
      const { token } = issueGuestToken();
      const [encodedPayload] = token.split(".");

      // Replace signature with garbage
      const result = validateGuestToken(`${encodedPayload}.invalidsignature`);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for swapped payload between two tokens", () => {
      const { token: token1 } = issueGuestToken();
      const { token: token2 } = issueGuestToken();

      const [payload1] = token1.split(".");
      const [, signature2] = token2.split(".");

      // Mix payload from token1 with signature from token2
      const result = validateGuestToken(`${payload1}.${signature2}`);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for expired token", () => {
      // Mock Date.now to issue a token in the past
      const realDateNow = Date.now;
      const pastTime = realDateNow() - 25 * 60 * 60 * 1000; // 25 hours ago
      vi.spyOn(Date, "now").mockReturnValue(pastTime);

      const { token } = issueGuestToken();

      // Restore Date.now — token should now be expired
      vi.spyOn(Date, "now").mockImplementation(realDateNow);

      const result = validateGuestToken(token);
      expect(result.valid).toBe(false);
    });

    it("accepts token just before expiry", () => {
      const realDateNow = Date.now;
      const issuedAt = realDateNow();
      vi.spyOn(Date, "now").mockReturnValue(issuedAt);

      const { token } = issueGuestToken();

      // Advance to just before expiry (23h 59m)
      const almostExpired = issuedAt + 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
      vi.spyOn(Date, "now").mockReturnValue(almostExpired);

      const result = validateGuestToken(token);
      expect(result.valid).toBe(true);
    });

    it("rejects token exactly at expiry", () => {
      const realDateNow = Date.now;
      const issuedAt = realDateNow();
      vi.spyOn(Date, "now").mockReturnValue(issuedAt);

      const { token } = issueGuestToken();

      // Advance to exactly 24h + 1ms after issuance
      const expired = issuedAt + 24 * 60 * 60 * 1000 + 1;
      vi.spyOn(Date, "now").mockReturnValue(expired);

      const result = validateGuestToken(token);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for base64url-encoded garbage payload", () => {
      const garbagePayload = Buffer.from("not json").toString("base64url");
      const garbageSignature = Buffer.from("sig").toString("base64url");

      const result = validateGuestToken(
        `${garbagePayload}.${garbageSignature}`,
      );
      expect(result.valid).toBe(false);
    });

    it("returns invalid for payload missing guestId", () => {
      // Manually craft a payload without guestId and sign it
      // Since we can't sign it properly without the secret, it should fail
      const payload = Buffer.from(
        JSON.stringify({ iat: Date.now(), exp: Date.now() + 100000 }),
      ).toString("base64url");
      const sig = Buffer.from("fakesig").toString("base64url");

      const result = validateGuestToken(`${payload}.${sig}`);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for payload missing exp", () => {
      const payload = Buffer.from(
        JSON.stringify({ guestId: "test", iat: Date.now() }),
      ).toString("base64url");
      const sig = Buffer.from("fakesig").toString("base64url");

      const result = validateGuestToken(`${payload}.${sig}`);
      expect(result.valid).toBe(false);
    });

    it("handles non-string token input gracefully", () => {
      const result = validateGuestToken(undefined as unknown as string);
      expect(result.valid).toBe(false);
    });
  });

  describe("security properties", () => {
    it("different tokens have different signatures", () => {
      const { token: t1 } = issueGuestToken();
      const { token: t2 } = issueGuestToken();

      const sig1 = t1.split(".")[1];
      const sig2 = t2.split(".")[1];

      expect(sig1).not.toBe(sig2);
    });

    it("same secret produces consistent validation", () => {
      const tokens = Array.from({ length: 5 }, () => issueGuestToken().token);

      for (const token of tokens) {
        expect(validateGuestToken(token).valid).toBe(true);
      }
    });

    it("tokens are not valid WorkOS-style JWTs", () => {
      // Guest tokens have 2 parts (payload.sig), not 3 (header.payload.sig)
      const { token } = issueGuestToken();
      expect(token.split(".").length).toBe(2);
    });
  });
});
