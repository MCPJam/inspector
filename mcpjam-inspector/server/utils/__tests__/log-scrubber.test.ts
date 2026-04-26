import { describe, it, expect } from "vitest";
import { scrubLogPayload } from "../log-scrubber.js";

describe("scrubLogPayload", () => {
  describe("forbidden key names", () => {
    it("redacts Authorization header key", () => {
      expect(scrubLogPayload({ Authorization: "Bearer abc" })).toEqual({
        Authorization: "[redacted]",
      });
    });

    it("redacts accessToken key", () => {
      expect(scrubLogPayload({ accessToken: "xyz" })).toEqual({
        accessToken: "[redacted]",
      });
    });

    it("redacts token key", () => {
      expect(scrubLogPayload({ token: "secret123" })).toEqual({
        token: "[redacted]",
      });
    });

    it("redacts cookie key", () => {
      expect(scrubLogPayload({ cookie: "session=abc" })).toEqual({
        cookie: "[redacted]",
      });
    });

    it("redacts password key", () => {
      expect(scrubLogPayload({ password: "hunter2" })).toEqual({
        password: "[redacted]",
      });
    });

    it("redacts secret key", () => {
      expect(scrubLogPayload({ clientSecret: "shh" })).toEqual({
        clientSecret: "[redacted]",
      });
    });

    it("redacts apiKey key (case-insensitive)", () => {
      expect(scrubLogPayload({ apiKey: "sk-123" })).toEqual({
        apiKey: "[redacted]",
      });
    });

    it("redacts email key", () => {
      expect(scrubLogPayload({ email: "user@example.com" })).toEqual({
        email: "[redacted]",
      });
    });

    it("does NOT redact emailDomain (allowlisted)", () => {
      expect(
        scrubLogPayload({ email: "a@b.com", emailDomain: "b.com" }),
      ).toEqual({
        email: "[redacted]",
        emailDomain: "b.com",
      });
    });

    it("redacts stripeCustomer key", () => {
      expect(scrubLogPayload({ stripeCustomer: "cus_123" })).toEqual({
        stripeCustomer: "[redacted]",
      });
    });
  });

  describe("string value patterns", () => {
    it("replaces Bearer token in string values", () => {
      const result = scrubLogPayload({ note: "Bearer eyJhbGc.eyJ.sig" });
      expect((result as any).note).toContain("Bearer [redacted-token]");
    });

    it("replaces JWT-like strings", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const result = scrubLogPayload({ note: jwt }) as any;
      expect(result.note).toBe("[redacted-jwt]");
    });

    it("replaces email-like strings in values", () => {
      const result = scrubLogPayload({ message: "contact user@example.com today" }) as any;
      expect(result.message).toContain("[redacted-email]");
      expect(result.message).not.toContain("user@example.com");
    });

    it("replaces sk- secret key patterns", () => {
      const result = scrubLogPayload({ note: "sk-abcdefghijklmnopqrstuvwx" }) as any;
      expect(result.note).toContain("[redacted-secret]");
    });
  });

  describe("recursion", () => {
    it("recurses into nested objects", () => {
      const input = {
        outer: {
          inner: {
            token: "secret",
            safe: "value",
          },
        },
      };
      expect(scrubLogPayload(input)).toEqual({
        outer: {
          inner: {
            token: "[redacted]",
            safe: "value",
          },
        },
      });
    });

    it("recurses into arrays", () => {
      const input = {
        items: [{ token: "abc" }, { safe: "ok" }],
      };
      expect(scrubLogPayload(input)).toEqual({
        items: [{ token: "[redacted]" }, { safe: "ok" }],
      });
    });

    it("handles null and undefined values", () => {
      expect(scrubLogPayload(null)).toBeNull();
      expect(scrubLogPayload(undefined)).toBeUndefined();
    });

    it("passes through numbers unchanged", () => {
      expect(scrubLogPayload({ count: 42 })).toEqual({ count: 42 });
    });
  });
});
