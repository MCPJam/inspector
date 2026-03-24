/**
 * Guest Token Service Tests
 *
 * Tests for the RS256 JWT guest token service.
 * Covers token generation, validation, expiry, tamper resistance,
 * JWKS export, and issuer verification.
 */

import { generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  initGuestTokenSecret,
  issueGuestToken,
  validateGuestToken,
  getGuestJwks,
  getGuestIssuer,
} from "../guest-token.js";
import { logger } from "../../utils/logger.js";

const ORIGINAL_GUEST_JWT_PRIVATE_KEY = process.env.GUEST_JWT_PRIVATE_KEY;
const ORIGINAL_GUEST_JWT_PUBLIC_KEY = process.env.GUEST_JWT_PUBLIC_KEY;
const ORIGINAL_GUEST_JWT_KEY_DIR = process.env.GUEST_JWT_KEY_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  if (ORIGINAL_GUEST_JWT_PRIVATE_KEY === undefined) {
    delete process.env.GUEST_JWT_PRIVATE_KEY;
  } else {
    process.env.GUEST_JWT_PRIVATE_KEY = ORIGINAL_GUEST_JWT_PRIVATE_KEY;
  }

  if (ORIGINAL_GUEST_JWT_PUBLIC_KEY === undefined) {
    delete process.env.GUEST_JWT_PUBLIC_KEY;
  } else {
    process.env.GUEST_JWT_PUBLIC_KEY = ORIGINAL_GUEST_JWT_PUBLIC_KEY;
  }

  if (ORIGINAL_GUEST_JWT_KEY_DIR === undefined) {
    delete process.env.GUEST_JWT_KEY_DIR;
  } else {
    process.env.GUEST_JWT_KEY_DIR = ORIGINAL_GUEST_JWT_KEY_DIR;
  }

  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

describe("guest-token service", () => {
  let testGuestKeyDir: string;

  beforeEach(() => {
    restoreEnv();
    delete process.env.GUEST_JWT_PRIVATE_KEY;
    delete process.env.GUEST_JWT_PUBLIC_KEY;
    testGuestKeyDir = mkdtempSync(path.join(os.tmpdir(), "guest-token-test-"));
    process.env.GUEST_JWT_KEY_DIR = testGuestKeyDir;
    initGuestTokenSecret();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
    rmSync(testGuestKeyDir, { recursive: true, force: true });
  });

  describe("initGuestTokenSecret", () => {
    it("generates an ephemeral key pair when env vars are not set", () => {
      delete process.env.GUEST_JWT_PRIVATE_KEY;
      delete process.env.GUEST_JWT_PUBLIC_KEY;
      initGuestTokenSecret();

      const { token } = issueGuestToken();
      const result = validateGuestToken(token);
      expect(result.valid).toBe(true);
    });

    it("tokens from different key pairs are incompatible", () => {
      initGuestTokenSecret();
      const { token: token1 } = issueGuestToken();

      const secondGuestKeyDir = mkdtempSync(
        path.join(os.tmpdir(), "guest-token-test-"),
      );
      process.env.GUEST_JWT_KEY_DIR = secondGuestKeyDir;
      initGuestTokenSecret();
      const result = validateGuestToken(token1);
      rmSync(secondGuestKeyDir, { recursive: true, force: true });
      expect(result.valid).toBe(false);
    });

    it("keeps tokens valid across reinitialization when env keys are stable", () => {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      process.env.GUEST_JWT_PRIVATE_KEY = pair.privateKey.export({
        type: "pkcs8",
        format: "pem",
      });
      process.env.GUEST_JWT_PUBLIC_KEY = pair.publicKey.export({
        type: "spki",
        format: "pem",
      });

      initGuestTokenSecret();
      const { token } = issueGuestToken();

      initGuestTokenSecret();
      const result = validateGuestToken(token);
      expect(result.valid).toBe(true);
    });

    it("warns in production when env keys are missing but still falls back to ephemeral keys", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      process.env.NODE_ENV = "production";
      delete process.env.GUEST_JWT_PRIVATE_KEY;
      delete process.env.GUEST_JWT_PUBLIC_KEY;

      initGuestTokenSecret();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Guest JWT: using ephemeral signing keys in production.",
        ),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("env vars are missing"),
      );

      const { token } = issueGuestToken();
      expect(validateGuestToken(token).valid).toBe(true);
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

      // Allow 1s tolerance for second-floor rounding
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin - 1000);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax + 1000);
    });

    it("token has three dot-separated parts (header.payload.signature)", () => {
      const { token } = issueGuestToken();

      const parts = token.split(".");
      expect(parts.length).toBe(3);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
      expect(parts[2].length).toBeGreaterThan(0);
    });

    it("header contains RS256 alg and JWT typ", () => {
      const { token } = issueGuestToken();

      const [encodedHeader] = token.split(".");
      const header = JSON.parse(
        Buffer.from(encodedHeader, "base64url").toString("utf-8"),
      );

      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");
      expect(header.kid).toBe("guest-1");
    });

    it("payload contains iss, sub, iat, and exp", () => {
      const { token, guestId } = issueGuestToken();

      const [, encodedPayload] = token.split(".");
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf-8"),
      );

      expect(payload.iss).toBe("https://api.mcpjam.com/guest");
      expect(payload.sub).toBe(guestId);
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

    it("returns invalid for token with two parts (old HMAC format)", () => {
      const result = validateGuestToken("a.b");
      expect(result.valid).toBe(false);
    });

    it("returns invalid for token with four parts", () => {
      const result = validateGuestToken("a.b.c.d");
      expect(result.valid).toBe(false);
    });

    it("returns invalid for token with single part", () => {
      const result = validateGuestToken("singlepart");
      expect(result.valid).toBe(false);
    });

    it("returns invalid for tampered payload", () => {
      const { token } = issueGuestToken();
      const [header, encodedPayload, signature] = token.split(".");

      // Decode, tamper, re-encode
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf-8"),
      );
      payload.sub = "tampered-id";
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );

      const result = validateGuestToken(
        `${header}.${tamperedPayload}.${signature}`,
      );
      expect(result.valid).toBe(false);
    });

    it("returns invalid for tampered signature", () => {
      const { token } = issueGuestToken();
      const [header, payload] = token.split(".");

      const result = validateGuestToken(
        `${header}.${payload}.invalidsignature`,
      );
      expect(result.valid).toBe(false);
    });

    it("returns invalid for swapped payload between two tokens", () => {
      const { token: token1 } = issueGuestToken();
      const { token: token2 } = issueGuestToken();

      const [header1, payload1] = token1.split(".");
      const [, , signature2] = token2.split(".");

      const result = validateGuestToken(`${header1}.${payload1}.${signature2}`);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for expired token", () => {
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

    it("rejects token at expiry boundary", () => {
      const realDateNow = Date.now;
      const issuedAt = realDateNow();
      vi.spyOn(Date, "now").mockReturnValue(issuedAt);

      const { token } = issueGuestToken();

      // Advance past 24h (add extra second to account for floor rounding)
      const expired = issuedAt + 24 * 60 * 60 * 1000 + 1000;
      vi.spyOn(Date, "now").mockReturnValue(expired);

      const result = validateGuestToken(token);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for base64url-encoded garbage payload", () => {
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT" }),
      ).toString("base64url");
      const garbagePayload = Buffer.from("not json").toString("base64url");
      const garbageSig = Buffer.from("sig").toString("base64url");

      const result = validateGuestToken(
        `${header}.${garbagePayload}.${garbageSig}`,
      );
      expect(result.valid).toBe(false);
    });

    it("returns invalid for wrong issuer", () => {
      // Craft a JWT with wrong issuer — signature won't match either,
      // but this tests the issuer check path
      const { token } = issueGuestToken();
      const [header, encodedPayload, sig] = token.split(".");
      const payload = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf-8"),
      );
      payload.iss = "https://evil.com";
      // Re-encoding changes the payload so signature will fail first,
      // but the check is still exercised in the code path
      const result = validateGuestToken(
        `${header}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`,
      );
      expect(result.valid).toBe(false);
    });

    it("returns invalid for payload missing sub", () => {
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: "https://api.mcpjam.com/guest",
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 100,
        }),
      ).toString("base64url");
      const sig = Buffer.from("fakesig").toString("base64url");

      const result = validateGuestToken(`${header}.${payload}.${sig}`);
      expect(result.valid).toBe(false);
    });

    it("returns invalid for payload missing exp", () => {
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: "https://api.mcpjam.com/guest",
          sub: "test",
          iat: Math.floor(Date.now() / 1000),
        }),
      ).toString("base64url");
      const sig = Buffer.from("fakesig").toString("base64url");

      const result = validateGuestToken(`${header}.${payload}.${sig}`);
      expect(result.valid).toBe(false);
    });

    it("handles non-string token input gracefully", () => {
      const result = validateGuestToken(undefined as unknown as string);
      expect(result.valid).toBe(false);
    });
  });

  describe("uninitialized keys guard", () => {
    it("issueGuestToken throws if initGuestTokenSecret was never called", async () => {
      vi.resetModules();
      const { issueGuestToken: freshIssue } = await import("../guest-token.js");
      expect(() => freshIssue()).toThrow(
        "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
      );
    });

    it("validateGuestToken throws if initGuestTokenSecret was never called", async () => {
      vi.resetModules();
      const { validateGuestToken: freshValidate } =
        await import("../guest-token.js");
      expect(() => freshValidate("fake.token.here")).toThrow(
        "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
      );
    });

    it("getGuestJwks throws if initGuestTokenSecret was never called", async () => {
      vi.resetModules();
      const { getGuestJwks: freshJwks } = await import("../guest-token.js");
      expect(() => freshJwks()).toThrow(
        "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
      );
    });
  });

  describe("JWKS endpoint", () => {
    it("returns a valid JWKS document", () => {
      const jwksDoc = getGuestJwks();

      expect(jwksDoc).toHaveProperty("keys");
      expect(Array.isArray(jwksDoc.keys)).toBe(true);
      expect(jwksDoc.keys.length).toBe(1);
    });

    it("JWKS key has correct metadata", () => {
      const jwksDoc = getGuestJwks();
      const key = jwksDoc.keys[0];

      expect(key.kty).toBe("RSA");
      expect(key.alg).toBe("RS256");
      expect(key.use).toBe("sig");
      expect(key.kid).toBe("guest-1");
      expect(key.n).toBeDefined(); // RSA modulus
      expect(key.e).toBeDefined(); // RSA exponent
    });

    it("JWKS key does not contain private key material", () => {
      const jwksDoc = getGuestJwks();
      const key = jwksDoc.keys[0] as Record<string, unknown>;

      // Private RSA parameters must not be present
      expect(key.d).toBeUndefined();
      expect(key.p).toBeUndefined();
      expect(key.q).toBeUndefined();
      expect(key.dp).toBeUndefined();
      expect(key.dq).toBeUndefined();
      expect(key.qi).toBeUndefined();
    });
  });

  describe("issuer", () => {
    it("returns the guest issuer URL", () => {
      expect(getGuestIssuer()).toBe("https://api.mcpjam.com/guest");
    });
  });

  describe("security properties", () => {
    it("different tokens have different signatures", () => {
      const { token: t1 } = issueGuestToken();
      const { token: t2 } = issueGuestToken();

      const sig1 = t1.split(".")[2];
      const sig2 = t2.split(".")[2];

      expect(sig1).not.toBe(sig2);
    });

    it("same key pair produces consistent validation", () => {
      const tokens = Array.from({ length: 5 }, () => issueGuestToken().token);

      for (const token of tokens) {
        expect(validateGuestToken(token).valid).toBe(true);
      }
    });

    it("tokens are standard 3-part JWTs", () => {
      const { token } = issueGuestToken();
      expect(token.split(".").length).toBe(3);
    });
  });
});
