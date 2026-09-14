/**
 * The challenge is the one free thing a 401 teaches us, and the one string
 * that must never be stored raw. These pin both halves: what the summary
 * keeps, and how the describer reads it ahead of the status.
 */

import { describe, expect, it } from "vitest";
import {
  bodyKindFromContentType,
  describeError,
  ERROR_CATALOG,
  summarizeBearerChallenge,
} from "../../src/error-describer/index.js";

function httpError(status: number, message = `HTTP ${status}`) {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = status;
  return err;
}

describe("summarizeBearerChallenge", () => {
  it("reads scheme, error, scopes and the metadata host — and nothing else", () => {
    const summary = summarizeBearerChallenge(
      'Bearer realm="mcp", error="invalid_token", scope="read write read", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource?x=secret"'
    );
    expect(summary).toEqual({
      scheme: "bearer",
      error: "invalid_token",
      scopes: ["read", "write"],
      resourceMetadataHost: "api.example.com",
    });
    // The pointer's query string — server-controlled, and this is persisted —
    // is not in the summary in any form.
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("well-known");
  });

  it("distinguishes no header, a non-Bearer header, and a Bearer challenge", () => {
    expect(summarizeBearerChallenge(undefined)).toEqual({ scheme: "none" });
    expect(summarizeBearerChallenge("")).toEqual({ scheme: "none" });
    expect(summarizeBearerChallenge('Basic realm="x"')).toEqual({
      scheme: "other",
    });
    // Bearer need not come first.
    expect(
      summarizeBearerChallenge('Basic realm="x", Bearer scope="a"').scheme
    ).toBe("bearer");
  });

  it("never throws on garbage and clips long values", () => {
    expect(
      summarizeBearerChallenge('Bearer error="' + "x".repeat(500))
    ).toMatchObject({ scheme: "bearer" });
    const clipped = summarizeBearerChallenge(
      `Bearer error="${"y".repeat(500)}"`
    );
    expect(clipped.error?.length).toBeLessThanOrEqual(120);
    expect(
      summarizeBearerChallenge('Bearer resource_metadata="not a url"')
    ).toEqual({ scheme: "bearer" });
  });

  it("carries the body kind through for the proxy case", () => {
    expect(bodyKindFromContentType("text/html; charset=utf-8")).toBe("html");
    expect(bodyKindFromContentType("application/json")).toBe("json");
    expect(bodyKindFromContentType(null, 0)).toBe("empty");
    expect(bodyKindFromContentType("text/plain")).toBe("text");
    expect(summarizeBearerChallenge(null, { bodyKind: "html" })).toEqual({
      scheme: "none",
      bodyKind: "html",
    });
  });
});

describe("describeError with a challenge / refresh context", () => {
  it("describes a missing challenge without claiming discovery is impossible", () => {
    const out = describeError(httpError(401), {
      challenge: { scheme: "none" },
      surface: "mcpServer",
    });
    expect(out.slug).toBe("oauth/no_bearer_challenge");
    expect(out.origin).toBe("ambiguous");
    expect(out.oneLine).not.toContain("cannot discover");
    expect(out.rawCode).toBe(401);
  });

  it("reads insufficient_scope off a 403 challenge", () => {
    const out = describeError(httpError(403), {
      challenge: {
        scheme: "bearer",
        error: "insufficient_scope",
        scopes: ["a"],
      },
    });
    expect(out.slug).toBe("auth/insufficient_scope");
    expect(out.origin).toBe("user_config");
  });

  it("flags an explicit invalid-token status mismatch and describes an HTML 403", () => {
    expect(
      describeError(httpError(403), {
        challenge: { scheme: "bearer", error: "invalid_token" },
      }).slug
    ).toBe("oauth/non_compliant_challenge");
    expect(
      describeError(httpError(403), {
        challenge: { scheme: "none", bodyKind: "html" },
      }).slug
    ).toBe("auth/proxy_rejected");
    // A bare 403 with a JSON body and no challenge is still the generic one.
    expect(
      describeError(httpError(403), {
        challenge: { scheme: "none", bodyKind: "json" },
      }).slug
    ).toBe("auth/http_403");
  });

  it("annotates the generic 401 with what the server reported", () => {
    const out = describeError(httpError(401), {
      challenge: { scheme: "bearer", error: "invalid_token" },
    });
    expect(out.slug).toBe("auth/http_401");
    expect(out.oneLine).toBe(
      `${ERROR_CATALOG["auth/http_401"].oneLine} The server reported \`invalid_token\`.`
    );
    // Copy without a challenge error is untouched.
    expect(describeError(httpError(401)).oneLine).toBe(
      ERROR_CATALOG["auth/http_401"].oneLine
    );
  });

  it("lets the refresh outcome win over the status, and promotes a managed refresh to ours", () => {
    const unreachable = describeError(new Error("refresh failed"), {
      refresh: { outcome: "authorization_server_unreachable" },
    });
    expect(unreachable.slug).toBe("auth/authorization_server_unreachable");
    expect(unreachable.origin).toBe("ambiguous");
    expect(
      describeError(new Error("refresh failed"), {
        refresh: { outcome: "authorization_server_unreachable" },
        credentialOwner: "mcpjam",
      }).origin
    ).toBe("mcpjam");
    // A 503 from our own control plane never reads as the MCP server's 5xx.
    const fromControlPlane = describeError(
      httpError(503, "authorization_server_unreachable"),
      {
        refresh: { outcome: "authorization_server_unreachable" },
      }
    );
    expect(fromControlPlane.slug).toBe("auth/authorization_server_unreachable");
    expect(
      describeError(httpError(401), { refresh: { outcome: "token_rejected" } })
        .slug
    ).toBe("auth/oauth_refresh_failed");
  });

  it("changes nothing for callers that pass no context", () => {
    expect(describeError(httpError(401)).slug).toBe("auth/http_401");
    expect(describeError(httpError(403)).slug).toBe("auth/http_403");
    expect(describeError(httpError(503)).slug).toBe("internal/unknown");
  });
});

describe("challenge selection and conservative diagnoses", () => {
  it("does not let a realm-only challenge hide insufficient_scope in either order", () => {
    for (const header of [
      'Bearer realm="general", Bearer error="insufficient_scope", scope="read"',
      'Bearer error="insufficient_scope", scope="read", Bearer realm="general"',
    ]) {
      const challenge = summarizeBearerChallenge(header);
      expect(describeError(httpError(403), { challenge })).toMatchObject({
        slug: "auth/insufficient_scope",
      });
      expect(challenge.scopes).toEqual(["read"]);
    }
  });
  it("does not infer invalid tokens or insufficient scope from a bare 403 challenge", () => {
    for (const challenge of [
      { scheme: "bearer" as const },
      { scheme: "bearer" as const, scopes: ["read"] },
    ]) {
      expect(describeError(httpError(403), { challenge }).slug).toBe(
        "auth/http_403"
      );
    }
    const html = describeError(httpError(403), {
      challenge: { scheme: "none", bodyKind: "html" },
    });
    expect(html.oneLine).toContain("may be involved");
    expect(html.origin).toBe("ambiguous");
  });
  it("redacts header-derived fields and caller-supplied challenge annotations", () => {
    const challenge = summarizeBearerChallenge(
      'Bearer error="Bearer secret-token"'
    );
    expect(JSON.stringify(challenge)).not.toContain("secret-token");
    expect(
      describeError(httpError(401), {
        challenge: { scheme: "bearer", error: "Bearer secret-token" },
      }).oneLine
    ).not.toContain("secret-token");
  });
});

it("uses structured status through cause wrappers and remains bounded on cycles", () => {
  const wrapped = new Error("Connect failed", { cause: httpError(403) });
  expect(
    describeError(wrapped, {
      challenge: { scheme: "bearer", error: "insufficient_scope" },
    })
  ).toMatchObject({ slug: "auth/insufficient_scope", rawCode: 403 });
  const cycle = new Error("unknown");
  cycle.cause = cycle;
  expect(describeError(cycle, { challenge: { scheme: "none" } }).slug).toBe(
    "internal/unknown"
  );
});
