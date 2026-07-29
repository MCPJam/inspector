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

    // Key-based redaction only walks object keys, so a secret sitting in a URL
    // *inside* a string (an error message, a logged path) used to survive.
    it("redacts secrets carried in URL query params", () => {
      const result = scrubLogPayload({
        errorMessage:
          "fetch failed for https://srv.example.com/mcp?access_token=abc123secret&foo=bar",
      }) as any;

      expect(result.errorMessage).not.toContain("abc123secret");
      expect(result.errorMessage).toContain("access_token=[redacted]");
      // The rest of the URL stays readable — that's the debugging value.
      expect(result.errorMessage).toContain("https://srv.example.com/mcp");
      expect(result.errorMessage).toContain("foo=bar");
    });

    it("redacts the OAuth authorization code and other secret params", () => {
      const result = scrubLogPayload({
        note: "cb https://a.dev/callback?code=authcode123&state=xyz789#api_key=k9",
      }) as any;

      expect(result.note).not.toContain("authcode123");
      expect(result.note).not.toContain("xyz789");
      expect(result.note).not.toContain("k9");
    });

    it("leaves non-secret query params alone", () => {
      const result = scrubLogPayload({
        note: "https://srv.example.com/mcp?projectId=v97abc&limit=10",
      }) as any;

      expect(result.note).toBe(
        "https://srv.example.com/mcp?projectId=v97abc&limit=10",
      );
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

  describe("cycle protection", () => {
    it("breaks circular object references with the [circular] sentinel", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b", a };
      a.b = b; // a -> b -> a

      const result = scrubLogPayload(a) as any;
      expect(result.name).toBe("a");
      expect(result.b.name).toBe("b");
      expect(result.b.a).toBe("[circular]");
    });

    it("breaks self-referential objects", () => {
      const o: Record<string, unknown> = { name: "self" };
      o.self = o;

      const result = scrubLogPayload(o) as any;
      expect(result.name).toBe("self");
      expect(result.self).toBe("[circular]");
    });

    it("breaks circular references through arrays", () => {
      const o: Record<string, unknown> = { items: [] as unknown[] };
      (o.items as unknown[]).push(o);

      const result = scrubLogPayload(o) as any;
      expect(result.items[0]).toBe("[circular]");
    });
  });
});
