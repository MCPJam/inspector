/**
 * Drift guard for the XAA jwt-bearer request body. Both the debugger's
 * `/proxy/token` endpoint and the connect-page mint build their token request
 * via `buildJwtBearerBody`, so this asserts the wire shape stays stable and
 * stays identical regardless of which surface calls it.
 */
import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import {
  buildJwtBearerBody,
  buildXaaMintArgs,
  resolveXaaIssuer,
} from "../xaa-mint.js";

/** Minimal hono Context stub for the issuer derivation. */
function ctxStub(url: string, forwardedProto?: string): Context {
  return {
    req: {
      url,
      header: (name: string) =>
        name === "x-forwarded-proto" ? forwardedProto : undefined,
    },
  } as unknown as Context;
}

describe("buildJwtBearerBody", () => {
  it("emits the RFC 7523 jwt-bearer grant with only the populated fields", () => {
    expect(
      buildJwtBearerBody({
        assertion: "the-id-jag",
        clientId: "client-1",
        clientSecret: "secret-1",
        scope: "read:tools",
        resource: "https://mcp.example.com",
      })
    ).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "the-id-jag",
      client_id: "client-1",
      client_secret: "secret-1",
      scope: "read:tools",
      resource: "https://mcp.example.com",
    });
  });

  it("omits empty/nullish optional fields (public client, no scope/resource)", () => {
    expect(
      buildJwtBearerBody({
        assertion: "the-id-jag",
        clientId: null,
        clientSecret: undefined,
        scope: "",
        resource: null,
      })
    ).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "the-id-jag",
    });
  });

  it("produces an identical body for the same inputs (connect vs debugger parity)", () => {
    const args = {
      assertion: "jag",
      clientId: "c",
      clientSecret: "s",
      scope: "a b",
      resource: "https://r.example.com",
    };
    expect(buildJwtBearerBody(args)).toEqual(buildJwtBearerBody(args));
  });
});

describe("resolveXaaIssuer", () => {
  it("uses /api/web and the forwarded https scheme in hosted mode", () => {
    // The TLS-terminating edge leaves c.req.url as http:// internally.
    const c = ctxStub("http://staging.mcpjam.com/api/web/servers/validate", "https");
    expect(resolveXaaIssuer(c, true)).toBe(
      "https://staging.mcpjam.com/api/web/xaa"
    );
  });

  it("uses /api/mcp and the request scheme off-hosted (no forwarded trust)", () => {
    const c = ctxStub("http://localhost:3001/api/mcp/servers/validate", "https");
    expect(resolveXaaIssuer(c, false)).toBe("http://localhost:3001/api/mcp/xaa");
  });
});

describe("buildXaaMintArgs", () => {
  const base = {
    issuer: "https://staging.mcpjam.com/api/web/xaa",
    serverId: "srv-1",
    projectId: "proj-1",
    bearerToken: "bearer-1",
    resolveServerSecret: async () => ({}) as any,
  };

  it("pins httpsOnly to hosted mode and passes the issuer through", () => {
    const args = buildXaaMintArgs({
      ...base,
      hostedMode: true,
      serverConfig: { url: "https://mcp.example.com/mcp" },
    });
    expect(args.httpsOnly).toBe(true);
    expect(args.issuer).toBe(base.issuer);
    expect(args.resource).toBe("https://mcp.example.com/mcp");
  });

  it("joins scopes and defaults the mock-login identity", () => {
    const args = buildXaaMintArgs({
      ...base,
      hostedMode: false,
      serverConfig: { url: "https://mcp.example.com/mcp", oauthScopes: ["a", "b"] },
    });
    expect(args.httpsOnly).toBe(false);
    expect(args.scope).toBe("a b");
    expect(args.subject).toBe("user-12345");
    expect(args.email).toBe("demo.user@example.com");
  });

  it("honors stored subject/email overrides", () => {
    const args = buildXaaMintArgs({
      ...base,
      hostedMode: true,
      serverConfig: {
        url: "https://mcp.example.com/mcp",
        xaaSubject: "alice@corp.com",
        xaaEmail: "alice@corp.com",
      },
    });
    expect(args.subject).toBe("alice@corp.com");
    expect(args.email).toBe("alice@corp.com");
  });
});
