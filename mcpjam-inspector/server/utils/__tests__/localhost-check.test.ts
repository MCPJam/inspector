/**
 * Localhost Check Utility Tests
 *
 * Tests for the Host header validation utility that ensures
 * tokens are only served to localhost requests.
 */

import { describe, it, expect } from "vitest";
import { isLocalhostRequest } from "../localhost-check.js";

describe("isLocalhostRequest", () => {
  describe("valid localhost values", () => {
    it("returns true for 'localhost'", () => {
      expect(isLocalhostRequest("localhost")).toBe(true);
    });

    it("returns true for 'localhost:6274' (with port)", () => {
      expect(isLocalhostRequest("localhost:6274")).toBe(true);
    });

    it("returns true for 'localhost:5173' (Vite port)", () => {
      expect(isLocalhostRequest("localhost:5173")).toBe(true);
    });

    it("returns true for 'localhost:8080' (Electron port)", () => {
      expect(isLocalhostRequest("localhost:8080")).toBe(true);
    });

    it("returns true for any port on localhost", () => {
      expect(isLocalhostRequest("localhost:3000")).toBe(true);
      expect(isLocalhostRequest("localhost:9999")).toBe(true);
      expect(isLocalhostRequest("localhost:1")).toBe(true);
    });
  });

  describe("IPv4 loopback (127.0.0.1)", () => {
    it("returns true for '127.0.0.1'", () => {
      expect(isLocalhostRequest("127.0.0.1")).toBe(true);
    });

    it("returns true for '127.0.0.1:6274' (with port)", () => {
      expect(isLocalhostRequest("127.0.0.1:6274")).toBe(true);
    });

    it("returns true for any port on 127.0.0.1", () => {
      expect(isLocalhostRequest("127.0.0.1:3000")).toBe(true);
      expect(isLocalhostRequest("127.0.0.1:80")).toBe(true);
    });
  });

  describe("IPv6 loopback ([::1])", () => {
    it("returns true for '[::1]'", () => {
      expect(isLocalhostRequest("[::1]")).toBe(true);
    });

    it("returns true for '[::1]:6274' (with port)", () => {
      expect(isLocalhostRequest("[::1]:6274")).toBe(true);
    });

    it("returns true for any port on [::1]", () => {
      expect(isLocalhostRequest("[::1]:3000")).toBe(true);
      expect(isLocalhostRequest("[::1]:443")).toBe(true);
    });
  });

  describe("case insensitivity", () => {
    it("handles uppercase 'LOCALHOST'", () => {
      expect(isLocalhostRequest("LOCALHOST")).toBe(true);
    });

    it("handles mixed case 'LocalHost'", () => {
      expect(isLocalhostRequest("LocalHost")).toBe(true);
    });

    it("handles uppercase with port", () => {
      expect(isLocalhostRequest("LOCALHOST:6274")).toBe(true);
    });
  });

  describe("non-localhost values", () => {
    it("returns false for external IPs", () => {
      expect(isLocalhostRequest("192.168.1.1")).toBe(false);
      expect(isLocalhostRequest("192.168.1.1:6274")).toBe(false);
      expect(isLocalhostRequest("10.0.0.1")).toBe(false);
      expect(isLocalhostRequest("172.16.0.1")).toBe(false);
    });

    it("returns false for public IPs", () => {
      expect(isLocalhostRequest("8.8.8.8")).toBe(false);
      expect(isLocalhostRequest("1.2.3.4:6274")).toBe(false);
    });

    it("returns false for domain names", () => {
      expect(isLocalhostRequest("example.com")).toBe(false);
      expect(isLocalhostRequest("example.com:6274")).toBe(false);
      expect(isLocalhostRequest("attacker.com")).toBe(false);
    });

    it("returns false for localhost-like domain names", () => {
      // DNS rebinding attack vectors
      expect(isLocalhostRequest("localhost.attacker.com")).toBe(false);
      expect(isLocalhostRequest("attacker-localhost.com")).toBe(false);
      expect(isLocalhostRequest("my-localhost:6274")).toBe(false);
    });

    it("returns false for partial localhost matches", () => {
      expect(isLocalhostRequest("notlocalhost")).toBe(false);
      expect(isLocalhostRequest("localhostx")).toBe(false);
      expect(isLocalhostRequest("xlocalhost")).toBe(false);
    });

    it("returns false for other loopback addresses", () => {
      // While 127.0.0.2-255 are technically loopback, we only allow 127.0.0.1
      expect(isLocalhostRequest("127.0.0.2")).toBe(false);
      expect(isLocalhostRequest("127.0.0.255")).toBe(false);
    });

    it("returns false for IPv6 without brackets", () => {
      // IPv6 in Host header requires brackets
      expect(isLocalhostRequest("::1")).toBe(false);
      expect(isLocalhostRequest("::1:6274")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for undefined", () => {
      expect(isLocalhostRequest(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isLocalhostRequest("")).toBe(false);
    });

    it("returns false for null (cast)", () => {
      expect(isLocalhostRequest(null as unknown as string)).toBe(false);
    });

    it("returns false for whitespace", () => {
      expect(isLocalhostRequest(" ")).toBe(false);
      expect(isLocalhostRequest("  localhost  ")).toBe(false);
    });

    it("handles localhost with path (not a real scenario)", () => {
      // Note: Host headers never include paths in real HTTP requests.
      // The path goes in the Request-URI, not the Host header.
      // This test documents the actual behavior, though it's not security-relevant.
      // "localhost/path" doesn't start with "localhost:" so returns false
      expect(isLocalhostRequest("localhost/path")).toBe(false);
      // "localhost:6274/api" starts with "localhost:" so returns true
      // This is fine because this scenario never occurs in real requests
      expect(isLocalhostRequest("localhost:6274/api")).toBe(true);
    });

    it("returns false for localhost with protocol", () => {
      // Host header should never include protocol
      expect(isLocalhostRequest("http://localhost")).toBe(false);
      expect(isLocalhostRequest("https://localhost:6274")).toBe(false);
    });
  });

  describe("security scenarios", () => {
    it("blocks DNS rebinding attack (attacker.com -> 127.0.0.1)", () => {
      // Even if attacker.com DNS resolves to 127.0.0.1,
      // the Host header will still be "attacker.com"
      expect(isLocalhostRequest("attacker.com")).toBe(false);
    });

    it("blocks requests when server bound to 0.0.0.0", () => {
      // When Docker exposes port, external users send their real Host
      expect(isLocalhostRequest("192.168.1.100:6274")).toBe(false);
      expect(isLocalhostRequest("external-hostname:6274")).toBe(false);
    });

    it("allows legitimate local development requests", () => {
      expect(isLocalhostRequest("localhost:6274")).toBe(true);
      expect(isLocalhostRequest("127.0.0.1:6274")).toBe(true);
    });
  });
});
