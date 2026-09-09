/**
 * MJ-003 — the origin rules, and the second place a stored credential is
 * composed onto a target.
 *
 * `originForCredentialBinding` decides whether a saved credential may still be
 * sent somewhere, so every arm of it is a security decision. The table is
 * deliberately exhaustive about the cases that look like conveniences —
 * default ports, host case, trailing dots — because each one is a way for a
 * single host to present as two origins, or two hosts as one.
 *
 * These rules are a hand-mirror of `convex/lib/canonicalUrl.ts` in
 * `mcpjam-backend`. They must agree: stricter here refuses connections the
 * backend considers fine, looser accepts a credential the backend would have
 * cleared.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSecretsOriginMatches,
  originForCredentialBinding,
  sameCredentialBindingOrigin,
} from "../secret-origin-binding.js";
import { resolveLocalServerForConnect } from "../local-server-resolver.js";

describe("originForCredentialBinding", () => {
  it.each([
    ["https://a.example.com/mcp", "https://a.example.com"],
    ["https://a.example.com", "https://a.example.com"],
    // Default ports collapse, so a URL written either way binds the same.
    ["https://a.example.com:443/mcp", "https://a.example.com"],
    ["http://a.example.com:80/mcp", "http://a.example.com"],
    // A non-default port is part of the origin.
    ["https://a.example.com:8443/mcp", "https://a.example.com:8443"],
    // Case and a trailing dot are the same NAME to a resolver, so they must be
    // the same origin here — otherwise `host.` is a free "different" origin
    // that resolves straight to the victim's host.
    ["https://A.Example.COM/mcp", "https://a.example.com"],
    ["https://a.example.com./mcp", "https://a.example.com"],
    // Path, query and fragment are not part of the binding.
    ["https://a.example.com/mcp?token=x#frag", "https://a.example.com"],
  ])("%s binds to %s", (input, expected) => {
    expect(originForCredentialBinding(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["not a url", "unparseable"],
    ["/mcp", "relative"],
    ["file:///etc/passwd", "file scheme"],
    ["data:text/plain,hi", "data scheme"],
    ["ws://a.example.com", "websocket scheme"],
  ])("%s is unbindable (%s)", (input) => {
    expect(originForCredentialBinding(input)).toBeNull();
  });

  it("treats null and undefined as unbindable rather than throwing", () => {
    expect(originForCredentialBinding(null)).toBeNull();
    expect(originForCredentialBinding(undefined)).toBeNull();
  });
});

describe("sameCredentialBindingOrigin", () => {
  it("compares a stored origin against a full target URL", () => {
    expect(
      sameCredentialBindingOrigin(
        "https://a.example.com",
        "https://a.example.com/mcp/v2"
      )
    ).toBe(true);
  });

  it.each([
    ["https://a.example.com", "http://a.example.com", "scheme downgrade"],
    ["https://a.example.com", "https://b.example.com", "different host"],
    ["https://a.example.com", "https://a.example.com:8443", "port added"],
    [
      "https://example.com",
      "https://evil.example.com",
      "subdomain of the same registrable domain",
    ],
    [
      "https://a.example.com",
      "https://a.example.com.evil.test",
      "suffix-extended host",
    ],
  ])("%s vs %s does not match (%s)", (a, b) => {
    expect(sameCredentialBindingOrigin(a, b)).toBe(false);
  });

  it("matches nothing when either side is unusable, including both", () => {
    // Fail closed. Two unparseable strings comparing equal would authorize a
    // credential against a target nobody can resolve.
    expect(sameCredentialBindingOrigin("garbage", "garbage")).toBe(false);
    expect(sameCredentialBindingOrigin(null, null)).toBe(false);
    expect(sameCredentialBindingOrigin("https://a.example.com", null)).toBe(
      false
    );
  });
});

describe("assertSecretsOriginMatches", () => {
  it("says the server moved and that re-entry is the fix", () => {
    // A bare "forbidden" reads as a permissions bug. This is the only place a
    // user sees the defence fire, so the message has to carry the next step.
    try {
      assertSecretsOriginMatches({
        boundOrigin: "https://owner.example.com",
        targetUrl: "https://attacker.example/mcp",
        serverName: "prod-api",
      });
      throw new Error("expected a refusal");
    } catch (error: any) {
      expect(error.status).toBe(403);
      expect(error.message).toContain("prod-api");
      expect(error.message).toContain("https://attacker.example");
      expect(error.message).toContain("https://owner.example.com");
      expect(error.message).toMatch(/re-enter/i);
      expect(error.details).toMatchObject({ secretOriginMismatch: true });
    }
  });

  it("reports an unrecorded binding as such rather than as a mismatch", () => {
    try {
      assertSecretsOriginMatches({
        boundOrigin: undefined,
        targetUrl: "https://owner.example.com/mcp",
      });
      throw new Error("expected a refusal");
    } catch (error: any) {
      // Same refusal, different cause — an operator chasing this needs to know
      // the row was never bound, not that somebody moved it.
      expect(error.message).toMatch(/not recorded against any origin/);
      expect(error.details.boundOrigin).toBeNull();
    }
  });
});

// Both resolver describes need Convex configured and the fetch stub torn down.
// Hoisted so a third one does not fork another copy and drift from these two.
const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const fakeContext = { set: () => {}, get: () => undefined } as any;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://example.convex.site";
});

afterEach(() => {
  if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
    delete process.env.CONVEX_HTTP_URL;
  } else {
    process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
  }
  vi.unstubAllGlobals();
});

describe("local resolver — MJ-003 gate (desktop and /api/mcp)", () => {
  function localAuthorize(serverConfig: Record<string, unknown>) {
    return vi.fn(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-1": {
                ok: true,
                role: "owner",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig,
                oauthAccessToken: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/web/server/reveal-secrets")) {
        return new Response(
          JSON.stringify({
            success: true,
            env: null,
            headers: { Authorization: "Bearer victim-credential" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
  }

  it("refuses a repointed row on the local path too", async () => {
    // The hosted merge in auth.ts is not the only place credentials are
    // composed onto a target — this resolver serves the desktop app and
    // /api/mcp. A fix that touched only auth.ts would leave this open.
    const fetchMock = localAuthorize({
      transportType: "http",
      url: "https://collector.attacker.example/mcp",
      headers: {},
      hasHeaders: true,
      secretsBoundOrigin: "https://owner.example.com",
      name: "prod-api",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(fakeContext, "bearer", "proj-1", "srv-1", {
        serverDisplayName: "prod-api",
      })
    ).rejects.toMatchObject({ status: 403 });

    // Refused before the reveal: only the authorize call went out.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attaches the credential when the binding matches", async () => {
    const fetchMock = localAuthorize({
      transportType: "http",
      url: "https://owner.example.com/mcp",
      headers: {},
      hasHeaders: true,
      secretsBoundOrigin: "https://owner.example.com",
      name: "prod-api",
    });
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer",
      "proj-1",
      "srv-1",
      { serverDisplayName: "prod-api" }
    );

    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer victim-credential",
    });
  });

  it("leaves a stdio row with secret env alone — it has no origin to bind", async () => {
    // Deliberately NOT gated: a stdio row has no url, so nothing was bound, and
    // its env reaches a locally-spawned child rather than a remote host. The
    // stdio exposure is a transport FLIP to http, which the backend's clear
    // covers write-side. Gating here would break every local stdio server.
    const fetchMock = localAuthorize({
      transportType: "stdio",
      command: "node",
      env: {},
      hasEnv: true,
      name: "local-stdio",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(fakeContext, "bearer", "proj-1", "srv-1", {
        serverDisplayName: "local-stdio",
      })
    ).resolves.toBeTruthy();
  });
});

describe("assertSecretsOriginMatches — malformed bindings", () => {
  it("reports a malformed binding as unrecorded, and does not echo it", () => {
    const stored = "not-a-url-at-all";
    try {
      assertSecretsOriginMatches({
        boundOrigin: stored,
        targetUrl: "https://owner.example.com/mcp",
      });
      throw new Error("expected a refusal");
    } catch (error: any) {
      // Still fails closed — but "saved for not-a-url-at-all" sends an operator
      // looking for a host that cannot exist, and puts an unvalidated stored
      // value into an error message on the way out.
      expect(error.message).toMatch(/not recorded against any origin/);
      expect(error.message).not.toContain(stored);
      expect(error.details.boundOrigin).toBeNull();
    }
  });
});

describe("local resolver — the OAuth half of the gate", () => {
  function authorizeOnly(serverConfig: Record<string, unknown>, token: unknown) {
    return vi.fn(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-1": {
                ok: true,
                role: "owner",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig,
                oauthAccessToken: token,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
  }

  it("refuses a repointed OAuth row that carries no secret headers", async () => {
    // The gap the review found: `hasHeaders` is false for an OAuth-only row, so
    // the header check never fired and the resolver went on to put the
    // row-derived bearer into Authorization for the new host.
    const fetchMock = authorizeOnly(
      {
        transportType: "http",
        url: "https://collector.attacker.example/mcp",
        headers: {},
        useOAuth: true,
        secretsBoundOrigin: "https://owner.example.com",
        name: "oauth-only",
      },
      "victim-oauth-token"
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(fakeContext, "bearer", "proj-1", "srv-1", {
        serverDisplayName: "oauth-only",
      })
    ).rejects.toMatchObject({ status: 403 });

    // Refused before any refresh: only the authorize call went out. A refresh
    // would have spent the row's stored refresh material against whatever
    // authorization server the attacker's host advertises.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attaches the OAuth bearer when the binding matches", async () => {
    const fetchMock = authorizeOnly(
      {
        transportType: "http",
        url: "https://owner.example.com/mcp",
        headers: {},
        useOAuth: true,
        secretsBoundOrigin: "https://owner.example.com",
        name: "oauth-only",
      },
      "valid-oauth-token"
    );
    vi.stubGlobal("fetch", fetchMock);

    const { config }: any = await resolveLocalServerForConnect(
      fakeContext,
      "bearer",
      "proj-1",
      "srv-1",
      { serverDisplayName: "oauth-only" }
    );
    expect(config.requestInit.headers).toMatchObject({
      Authorization: "Bearer valid-oauth-token",
    });
  });

  it("refuses an OAuth row with no recorded binding at all", async () => {
    // Absence, not mismatch. This is the pre-backfill shape, and the one the
    // /api/mcp connect fixtures carried until this change: an unbound row
    // holding a credential is a refusal, never consent.
    const fetchMock = authorizeOnly(
      {
        transportType: "http",
        url: "https://owner.example.com/mcp",
        headers: {},
        useOAuth: true,
      },
      "victim-oauth-token"
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(fakeContext, "bearer", "proj-1", "srv-1", {
        serverDisplayName: "oauth-only",
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a repointed discover row whose refresh produced a token", async () => {
    // The discover rung holds no token on the way in, so the gate above it
    // cannot fire — and the refresh then spends the row's stored material and
    // hands back a bearer. Without the second check that bearer went to the
    // new host.
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/web/authorize-batch-local")) {
        return new Response(
          JSON.stringify({
            results: {
              "srv-1": {
                ok: true,
                role: "owner",
                accessLevel: "project_member",
                permissions: { chatOnly: false },
                serverConfig: {
                  transportType: "http",
                  url: "https://collector.attacker.example/mcp",
                  headers: {},
                  authMethod: "auto",
                  secretsBoundOrigin: "https://owner.example.com",
                },
                oauthAccessToken: null,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/web/oauth/force-refresh")) {
        return new Response(
          JSON.stringify({ accessToken: "refreshed-victim-token" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(fakeContext, "bearer", "proj-1", "srv-1", {
        serverDisplayName: "discover-row",
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("leaves an unauthenticated row alone, bound or not", async () => {
    // No credential of any kind, so nothing is at risk and the gate must not
    // fire — this is the case that would break every public MCP server if the
    // check were keyed on a missing binding rather than on holding a credential.
    const fetchMock = authorizeOnly(
      {
        transportType: "http",
        url: "https://public.example.com/mcp",
        headers: {},
        name: "public",
      },
      null
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveLocalServerForConnect(fakeContext, "bearer", "proj-1", "srv-1", {
        serverDisplayName: "public",
      })
    ).resolves.toBeTruthy();
  });
});
