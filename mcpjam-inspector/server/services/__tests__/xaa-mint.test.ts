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
  buildJwtBearerRequest,
  buildXaaMintArgs,
  resolveXaaIssuer,
  scopeXaaIssuerForAuthorizedProject,
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

describe("scopeXaaIssuerForAuthorizedProject", () => {
  it("uses the authorized org scope for signed-in hosted projects", () => {
    expect(
      scopeXaaIssuerForAuthorizedProject({
        issuer: "https://app.mcpjam.com/api/web/xaa",
        hostedMode: true,
        organizationId: "org-1",
        isAnonymous: false,
      })
    ).toBe("https://app.mcpjam.com/api/web/xaa/o/org-1");
  });

  it("uses the visibly anonymous issuer for hosted guest projects", () => {
    expect(
      scopeXaaIssuerForAuthorizedProject({
        issuer: "https://app.mcpjam.com/api/web/xaa",
        hostedMode: true,
        organizationId: "org guest",
        isAnonymous: true,
      })
    ).toBe("https://app.mcpjam.com/api/web/xaa/g/org%20guest");
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

  it("threads the authorized CIMD strategy without reading it from the browser", () => {
    const provider = {
      getClientIdMetadataUrl: () => "https://app.mcpjam.com/cimd/key",
      signClientAssertion: () => "assertion",
    };
    const args = buildXaaMintArgs({
      ...base,
      hostedMode: true,
      organizationId: "org-1",
      isAnonymous: false,
      confidentialCimdProvider: provider,
      serverConfig: {
        url: "https://mcp.example.com/mcp",
        xaaAuthzIssuer: "https://auth.example.com",
        registrationMode: "cimd",
        xaaClientAuth: "private_key_jwt",
      },
    });

    expect(args.issuer).toBe("https://staging.mcpjam.com/api/web/xaa/o/org-1");
    expect(args.registrationMode).toBe("cimd");
    expect(args.xaaClientAuth).toBe("private_key_jwt");
    expect(args.explicitIssuer).toBe("https://auth.example.com");
    expect(args.confidentialCimdProvider).toBe(provider);
  });
});

describe("buildJwtBearerRequest", () => {
  const args = {
    assertion: "the-id-jag",
    clientId: "client:with/reserved chars",
    clientSecret: "secret+with/reserved=chars",
    scope: "read",
    resource: "https://mcp.example.com",
  };

  it("keeps credentials in the form body for client_secret_post and the legacy default", () => {
    for (const method of ["client_secret_post", undefined] as const) {
      const request = buildJwtBearerRequest({
        ...args,
        tokenEndpointAuthMethod: method,
      });
      expect(request.headers).toEqual({});
      expect(request.body).toEqual(
        buildJwtBearerBody(args)
      );
      expect(request.body.client_secret).toBe(args.clientSecret);
    }
  });

  it("builds an RFC 6749 Basic header (application/x-www-form-urlencoded before Base64) and strips the secret from the body", () => {
    // Mirror the production form-urlencoder: space→"+", "!'()~" percent-encoded.
    const formUrlEncode = (v: string) =>
      encodeURIComponent(v)
        .replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
        .replace(/%20/g, "+");
    const withSpaces = {
      ...args,
      clientId: "client id!",
      clientSecret: "secret (with)~chars",
    };
    const request = buildJwtBearerRequest({
      ...withSpaces,
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    const expected = Buffer.from(
      `${formUrlEncode(withSpaces.clientId)}:${formUrlEncode(withSpaces.clientSecret)}`
    ).toString("base64");
    expect(request.headers).toEqual({ Authorization: `Basic ${expected}` });
    // Space must NOT be %20 (that would be encodeURIComponent, not form-encoding).
    expect(Buffer.from(expected, "base64").toString()).toContain("client+id");
    // With Basic, BOTH client_id and secret live in the header only — the body
    // must not repeat client_id (some endpoints reject dual-carried client_id).
    expect(request.body.client_secret).toBeUndefined();
    expect(request.body.client_id).toBeUndefined();
    expect(request.body.assertion).toBe(args.assertion);
  });

  it("throws when client_secret_basic lacks a credential", () => {
    expect(() =>
      buildJwtBearerRequest({
        assertion: "a",
        clientId: "c",
        tokenEndpointAuthMethod: "client_secret_basic",
      })
    ).toThrow(/client_secret_basic/);
    expect(() =>
      buildJwtBearerRequest({
        assertion: "a",
        clientSecret: "s",
        tokenEndpointAuthMethod: "client_secret_basic",
      })
    ).toThrow(/client_secret_basic/);
  });

  it("requires a client_id for public (none) and client_secret_post clients", () => {
    expect(() =>
      buildJwtBearerRequest({
        assertion: "a",
        tokenEndpointAuthMethod: "none",
      })
    ).toThrow(/client_id/);
    expect(() =>
      buildJwtBearerRequest({
        assertion: "a",
        clientSecret: "s",
        tokenEndpointAuthMethod: "client_secret_post",
      })
    ).toThrow(/client_id/);
  });

  it("sends no secret anywhere for a public (none) client", () => {
    const request = buildJwtBearerRequest({
      ...args,
      tokenEndpointAuthMethod: "none",
    });
    expect(request.headers).toEqual({});
    expect(request.body.client_id).toBe(args.clientId);
    expect(JSON.stringify(request.body)).not.toContain(args.clientSecret);
  });
});
