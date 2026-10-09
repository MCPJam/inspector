import { describe, it, expect } from "vitest";
import { describeShape, scrubLogPayload, scrubLogText } from "../log-scrubber";

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
      // The URL is cut to its origin, which takes the query with it; the host
      // is what says which server failed.
      expect(result.message).toBe("fetch failed for https://mcp.example.com/…");
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
        // The host stays readable — that's the debugging value.
        expect(result.message).toContain("https://mcp.example.com/…");
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
      expect(result.message).toBe("https://h/…");
    });

    it("still redacts authorization as a query param outside a URL", () => {
      const result = scrubLogPayload({
        message: "retrying /mcp?authorization=urlsecret&x=1",
      }) as any;

      expect(result.message).toBe("retrying /mcp?authorization=[redacted]&x=1");
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
      expect(result.message).not.toContain("user");
      expect(result.message).toContain("https://internal.host/…");

      // Schemes the URL reducer leaves alone still lose their userinfo.
      const db = scrubLogPayload({
        message: "connect failed for postgres://admin:hunter2@db.internal/app",
      }) as any;
      expect(db.message).not.toContain("hunter2");
      expect(db.message).toContain("[redacted]@db.internal");
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

  // Realistic payloads: what a route actually had in hand when it logged.
  // Each one asserts both halves — the customer's values are gone, and the
  // structure someone debugging needs is still there.
  describe("customer content", () => {
    it("keeps a chat request's structure and drops its words", () => {
      const result = scrubLogPayload({
        requestId: "req_123",
        modelId: "anthropic/claude-sonnet-4.5",
        body: {
          messages: [
            {
              id: "msg_1",
              role: "user",
              parts: [
                {
                  type: "text",
                  text: "My SSN is 123-45-6789, summarize my chart",
                },
              ],
            },
          ],
          systemPrompt: "You are the clinic's assistant.",
          temperature: 0.2,
          selectedServers: ["srv_abc"],
        },
      }) as any;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("123-45-6789");
      expect(serialized).not.toContain("clinic");
      expect(result.requestId).toBe("req_123");
      expect(result.modelId).toBe("anthropic/claude-sonnet-4.5");
      expect(result.body).toBe(
        "{messages: array(1)<{id: string(5), role: string(4), parts: array(1)}>, systemPrompt: string(31), temperature: number, selectedServers: array(1)<string(7)>}",
      );
    });

    it("shapes content keys wherever they sit and keeps their siblings", () => {
      const result = scrubLogPayload({
        sessionId: "sess_1",
        messages: [{ role: "user", content: "call me at 555-0100" }],
        prompt: "Plan a trip to Lisbon",
        toolArgs: { city: "Lisbon", nights: 3 },
        messageContent: "hello there",
        testCaseSnapshot: { query: "book a flight", expectedToolCalls: [] },
        serverName: "Acme Prod CRM",
        title: "Refund flow for VIP customers",
      }) as any;

      expect(result).toEqual({
        sessionId: "sess_1",
        messages: "array(1)<{role: string(4), content: string(19)}>",
        prompt: "string(21)",
        toolArgs: "{city: string(6), nights: number}",
        messageContent: "string(11)",
        testCaseSnapshot: "{query: string(13), expectedToolCalls: array(0)}",
        serverName: "string(13)",
        title: "string(29)",
      });
    });

    it("keeps an MCP tool call's method, ids and tool name but not its arguments or result", () => {
      const result = scrubLogPayload({
        serverId: "srv_1",
        toolName: "create_invoice",
        request: {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "create_invoice",
            arguments: {
              customerEmail: "jane@acme.com",
              amount: 4200,
              memo: "Q3 retainer",
            },
          },
        },
        result: {
          content: [{ type: "text", text: "Invoice INV-99 created for Jane" }],
          isError: false,
        },
      }) as any;

      const serialized = JSON.stringify(result);
      for (const value of ["jane@acme.com", "4200", "Q3 retainer", "INV-99"]) {
        expect(serialized, `${value} leaked`).not.toContain(value);
      }
      expect(result.toolName).toBe("create_invoice");
      expect(result.request).toMatchObject({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
      });
      expect(result.request.params).toBe(
        "{name: string(14), arguments: {customerEmail: string(13), amount: number, memo: string(11)}}",
      );
      expect(result.result).toBe(
        "{content: array(1)<{type: string(4), text: string(31)}>, isError: boolean}",
      );
    });

    it("keeps an OAuth token response's metadata and redacts every token", () => {
      const result = scrubLogPayload({
        serverId: "srv_1",
        tokenEndpoint: "https://auth.acme.com/tenants/acme/oauth/token?x=1",
        status: 200,
        response: {
          access_token:
            "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJlLXZhbHVl",
          refresh_token: "rt_9f8e7d6c",
          id_token: "eyJ.id.token",
          expires_in: 3600,
          scope: "openid profile",
        },
      }) as any;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("eyJ");
      expect(serialized).not.toContain("rt_9f8e7d6c");
      expect(serialized).not.toContain("tenants");
      // `token` in the key name would redact it outright; a bare URL there
      // names where a credential goes, and its host is the diagnostic.
      expect(result.tokenEndpoint).toBe("https://auth.acme.com/…");
      expect(result.status).toBe(200);
      expect(result.response.expires_in).toBe(3600);
      expect(result.response.scope).toBe("openid profile");
    });

    it("keeps an error's name, code and status and redacts its text", () => {
      const error = Object.assign(
        new Error(
          "POST https://mcp.acme.com/v1/tenants/42/sse?session=abc failed for " +
            "jane.doe@acme.com (401): Authorization: Bearer sk-live-abcdefghijklmnop",
        ),
        { code: "UPSTREAM_401", status: 401 },
      );

      const result = scrubLogPayload({ serverId: "srv_1", error }) as any;

      expect(result.error).toMatchObject({
        name: "Error",
        code: "UPSTREAM_401",
        status: 401,
        message:
          "POST https://mcp.acme.com/… failed for [redacted-email] (401): Authorization: [redacted]",
      });
      // The stack's first line repeats the message; it is scrubbed the same.
      expect(result.error.stack).not.toContain("jane.doe");
      expect(result.error.stack).not.toContain("sk-live");
      expect(result.error.stack).toContain("at ");
    });

    it("treats error-named keys as error text, not content", () => {
      const result = scrubLogPayload({
        errorBody: '{"error":"invalid_grant","error_description":"expired"}',
        upstreamErrors: ["a".repeat(800), "ECONNRESET"],
        stderr: `npm ERR! ${"x".repeat(600)}`,
      }) as any;

      // An upstream error body is the cause, so a capped prefix survives.
      expect(result.errorBody).toBe(
        '{"error":"invalid_grant","error_description":"expired"}',
      );
      expect(result.upstreamErrors[0]).toBe(`${"a".repeat(500)}… [+300 chars]`);
      expect(result.upstreamErrors[1]).toBe("ECONNRESET");
      expect(result.stderr.startsWith("npm ERR! ")).toBe(true);
      expect(result.stderr.endsWith("… [+109 chars]")).toBe(true);
    });

    it("caps long free text and long arrays", () => {
      const result = scrubLogPayload({
        note: "y".repeat(1200),
        ids: Array.from({ length: 60 }, (_, i) => `id_${i}`),
      }) as any;

      expect(result.note).toBe(`${"y".repeat(1000)}… [+200 chars]`);
      expect(result.ids).toHaveLength(51);
      expect(result.ids[49]).toBe("id_49");
      expect(result.ids[50]).toBe("[+10 more]");
    });

    it("leaves non-web URI schemes alone", () => {
      // An MCP App's template URI is a dashboard dimension, not customer data.
      expect(
        scrubLogPayload({ resourceUri: "ui://widget/weather.html" }),
      ).toEqual({ resourceUri: "ui://widget/weather.html" });
    });
  });
});

describe("scrubLogText", () => {
  it("cuts web URLs to their origin and keeps bare ones intact", () => {
    expect(
      scrubLogText(
        "GET https://api.acme.com/v2/users/42?expand=1 → wss://rt.acme.com:8443/socket, retry https://acme.com",
      ),
    ).toBe(
      "GET https://api.acme.com/… → wss://rt.acme.com:8443/…, retry https://acme.com",
    );
  });

  it("is idempotent", () => {
    const once = scrubLogText(
      "fetch https://a.example.com/x?token=1 for bob@example.com",
    );
    expect(scrubLogText(once)).toBe(once);
  });

  it("caps at the length it is given", () => {
    expect(scrubLogText("abcdef", 3)).toBe("abc… [+3 chars]");
  });
});

describe("describeShape", () => {
  it("bounds depth, key count and output length", () => {
    const deep = { a: { b: { c: { d: "too deep" } } } };
    expect(describeShape(deep)).toBe("{a: {b: {c: object(1 keys)}}}");

    const wide = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`k${i}`, i]),
    );
    expect(describeShape(wide)).toContain("k11: number, …+3}");

    const long = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `a_rather_long_key_name_number_${i}`,
        { nested: "value" },
      ]),
    );
    expect(describeShape(long).length).toBeLessThanOrEqual(520);
  });

  it("names leaves without their values", () => {
    expect(
      describeShape({
        when: new Date(0),
        bytes: new Uint8Array(16),
        fn: () => 1,
        missing: null,
        failure: new Error("secret detail"),
      }),
    ).toBe(
      "{when: date, bytes: bytes(16), fn: function, missing: null, failure: error}",
    );
  });

  it("redacts emails used as keys", () => {
    expect(describeShape({ "jane@acme.com": 1 })).toBe(
      "{[redacted-email]: number}",
    );
  });

  it("marks cycles and survives a throwing getter", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeShape(cyclic)).toBe("{self: circular}");

    const hostile = {
      get boom(): never {
        throw new Error("trap");
      },
    };
    expect(describeShape(hostile)).toBe("unreadable");
  });
});
