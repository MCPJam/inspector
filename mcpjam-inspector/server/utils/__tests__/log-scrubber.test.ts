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

    it("redacts secret-ish query params quoted inside error strings", () => {
      // Raw upstream error messages routinely quote full request URLs; the
      // key-based redaction can't see inside a string value.
      const result = scrubLogPayload({
        message:
          "fetch failed for https://mcp.example.com/sse?api_key=plain-secret&x=1",
      }) as any;
      expect(result.message).not.toContain("plain-secret");
      expect(result.message).toContain("api_key=[redacted]");
    });

    // The object-key scrubber redacts all of these names; a URL quoted inside
    // a string value has to reach the same bar. `authorization` needed its own
    // alternative — `auth` alone can't match it, since the trailing
    // "orization" blocks the `[=:]` that has to follow.
    it("redacts camelCase and authorization credentials in quoted URLs", () => {
      const names = [
        "accessToken",
        "refreshToken",
        "idToken",
        "clientSecret",
        "apiKey",
        "authorization",
      ];

      for (const name of names) {
        const result = scrubLogPayload({
          message: `fetch failed for https://mcp.example.com/sse?${name}=plain-secret&x=1`,
        }) as any;
        expect(result.message, `${name} leaked`).not.toContain("plain-secret");
        expect(result.message).toContain(`${name}=[redacted]`);
        // The rest of the URL stays readable — that's the debugging value.
        expect(result.message).toContain("https://mcp.example.com/sse");
      }
    });

    // `SECRET_PARAM_LIKE` stops at the first whitespace — right for a query
    // param, wrong for a header, where it redacted only the scheme word and
    // left the credential. `Bearer` was covered incidentally by TOKEN_LIKE;
    // these schemes were not.
    it("redacts the whole Authorization header value for any scheme", () => {
      const credentials: Array<[string, string]> = [
        ["Basic", "dXNlcjpwYXNz"],
        ["Digest", "username=alice, response=deadbeef"],
        ["Negotiate", "YIIZkAYGKwYBBQUCoIIZ"],
        ["Bearer", "abc.def.ghi"],
      ];

      for (const [scheme, credential] of credentials) {
        const result = scrubLogPayload({
          message: `Authorization: ${scheme} ${credential}`,
        }) as any;
        expect(result.message, `${scheme} leaked`).not.toContain(credential);
        expect(result.message).toBe("Authorization: [redacted]");
      }
    });

    it("does not swallow siblings of a JSON-embedded Authorization header", () => {
      const result = scrubLogPayload({
        message: '{"authorization":"Basic dXNlcjpwYXNz","keep":"me"}',
      }) as any;

      expect(result.message).not.toContain("dXNlcjpwYXNz");
      expect(result.message).toContain('"keep":"me"');
    });

    it("still redacts authorization as a URL query param", () => {
      const result = scrubLogPayload({
        message: "https://h/mcp?authorization=urlsecret&x=1",
      }) as any;

      expect(result.message).not.toContain("urlsecret");
      expect(result.message).toBe("https://h/mcp?authorization=[redacted]&x=1");
    });

    it("redacts key=value and key: value secret assignments", () => {
      const result = scrubLogPayload({
        message: 'connect failed (token=abc123, client_secret: "s3cr3t")',
      }) as any;
      expect(result.message).not.toContain("abc123");
      expect(result.message).not.toContain("s3cr3t");
    });

    it("redacts basic-auth credentials in URLs", () => {
      const result = scrubLogPayload({
        message: "getaddrinfo ENOTFOUND for https://user:hunter2@internal.host/mcp",
      }) as any;
      expect(result.message).not.toContain("hunter2");
      expect(result.message).toContain("[redacted]@internal.host");
    });

    it("leaves ordinary error strings readable", () => {
      const message =
        "connect ECONNREFUSED 127.0.0.1:8080 (timeout: 30000, retries: 1)";
      const result = scrubLogPayload({ message }) as any;
      expect(result.message).toBe(message);
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
