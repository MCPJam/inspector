/**
 * The non-invasive auth checks.
 *
 * Three corrections from the rev-2 audit are pinned here as named tests,
 * because each one is a place a reasonable implementation gets it wrong in a
 * way that looks right:
 *
 *   - a broken `authorization_servers[0]` is a BLOCKER, not a warning, because
 *     Claude never falls back to entry one;
 *   - `scope` is OPTIONAL on an `insufficient_scope` challenge;
 *   - a JWT `aud` that does not name the resource proves nothing.
 *
 * Plus the classify-don't-fail rule, which is what keeps a static-header or
 * preregistered-client connector from being reported as broken.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalResourceIndicator,
  runClaudeAuthChecks,
  type ClaudeAuthEvidence,
} from "../../src/claude-readiness/checks/auth.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };
const URL_UNDER_TEST = "https://mcp.example.com/mcp";

function byId(
  output: ReturnType<typeof runClaudeAuthChecks>,
  id: string,
) {
  return output.findings.find((finding) => finding.id === id)!;
}

function badge(output: ReturnType<typeof runClaudeAuthChecks>, id: string) {
  return output.badges.find((entry) => entry.id === id)!;
}

const HEALTHY: ClaudeAuthEvidence = {
  enteredUrl: URL_UNDER_TEST,
  unauthenticated: {
    status: 401,
    wwwAuthenticate:
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    representsProtectedOperation: true,
    servedWithoutCredentials: false,
  },
  prm: {
    discoveredVia: "www-authenticate",
    url: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    document: {
      resource: URL_UNDER_TEST,
      authorization_servers: ["https://auth.example.com"],
    },
  },
  firstAuthorizationServer: {
    issuer: "https://auth.example.com",
    metadataUrl: "https://auth.example.com/.well-known/oauth-authorization-server",
    reachable: true,
    document: {
      issuer: "https://auth.example.com",
      registration_endpoint: "https://auth.example.com/register",
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    },
  },
};

describe("a healthy OAuth connector", () => {
  it("satisfies every applicable runtime requirement", () => {
    const output = runClaudeAuthChecks(HEALTHY, STAMP);
    const violations = output.findings.filter((f) => f.status === "violated");
    expect(violations).toEqual([]);
  });

  it("badges the auth mode it could actually determine", () => {
    expect(badge(runClaudeAuthChecks(HEALTHY, STAMP), "claude.auth.mode")).toMatchObject(
      { state: "supported", provenance: "wire" },
    );
  });
});

describe("authorization_servers[0] is a blocker", () => {
  const broken: ClaudeAuthEvidence = {
    ...HEALTHY,
    prm: {
      ...HEALTHY.prm!,
      document: {
        resource: URL_UNDER_TEST,
        authorization_servers: [
          "https://broken.example.com",
          "https://auth.example.com",
        ],
      },
    },
    firstAuthorizationServer: {
      issuer: "https://broken.example.com",
      reachable: false,
      fetchError: "ENOTFOUND",
    },
  };

  it("fails even though a healthy server is listed second", () => {
    const finding = byId(
      runClaudeAuthChecks(broken, STAMP),
      "claude.auth.first-authorization-server-usable",
    );
    expect(finding.status).toBe("violated");
    // A runtime blocker, not a recommendation: Claude cannot use the connector.
    expect(finding.class).toBe("runtime-blocker");
    expect(finding.remediation).toMatch(/does not fall back/);
  });

  it("names the entries it did not try, so the rule is concrete", () => {
    expect(
      byId(runClaudeAuthChecks(broken, STAMP), "claude.auth.first-authorization-server-usable")
        .details,
    ).toMatchObject({ otherEntries: ["https://auth.example.com"] });
  });

  it("leaves the downstream metadata checks unevaluated rather than failed", () => {
    // The metadata was never read; calling those requirements violated would
    // invent findings about a document nobody saw.
    for (const id of [
      "claude.auth.pkce-s256-advertised",
      "claude.auth.cimd-flag-consistent",
      "claude.auth.client-acquisition-path",
    ]) {
      expect(byId(runClaudeAuthChecks(broken, STAMP), id).status).toBe(
        "not-evaluated",
      );
    }
  });
});

describe("the PRM resource check is about the ENTERED url", () => {
  it("fails a trailing-slash mismatch", () => {
    const finding = byId(
      runClaudeAuthChecks(
        {
          ...HEALTHY,
          prm: {
            ...HEALTHY.prm!,
            document: {
              resource: `${URL_UNDER_TEST}/`,
              authorization_servers: ["https://auth.example.com"],
            },
          },
        },
        STAMP,
      ),
      "claude.auth.prm-resource-matches-entered-url",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toMatch(/trailing slash/);
  });

  it("is separate from the canonical-form requirement", () => {
    // A server can declare the entered URL correctly and still have a client
    // send a non-canonical `resource`; one check cannot cover both.
    const output = runClaudeAuthChecks(HEALTHY, STAMP);
    expect(byId(output, "claude.auth.prm-resource-matches-entered-url").status).toBe(
      "satisfied",
    );
    expect(byId(output, "claude.auth.rfc8707-resource-canonical").status).toBe(
      "not-evaluated",
    );
    expect(
      byId(output, "claude.auth.rfc8707-resource-canonical").requiresCapabilities,
    ).toContain("interactive-oauth");
  });
});

describe("the RFC 8707 resource parameter, once an authorization happened", () => {
  it("passes the canonical form on both endpoints", () => {
    expect(
      byId(
        runClaudeAuthChecks(
          {
            ...HEALTHY,
            resourceIndicatorsSent: {
              authorize: URL_UNDER_TEST,
              token: URL_UNDER_TEST,
            },
          },
          STAMP,
        ),
        "claude.auth.rfc8707-resource-canonical",
      ).status,
    ).toBe("satisfied");
  });

  it("fails a non-canonical value and names the endpoint that sent it", () => {
    const finding = byId(
      runClaudeAuthChecks(
        {
          ...HEALTHY,
          resourceIndicatorsSent: {
            authorize: URL_UNDER_TEST,
            token: `${URL_UNDER_TEST}?tenant=acme`,
          },
        },
        STAMP,
      ),
      "claude.auth.rfc8707-resource-canonical",
    );
    expect(finding.status).toBe("violated");
    expect(finding.details).toMatchObject({ endpoints: ["token"] });
  });

  it("grades an endpoint that carried the parameter and ignores one that did not", () => {
    expect(
      byId(
        runClaudeAuthChecks(
          { ...HEALTHY, resourceIndicatorsSent: { authorize: URL_UNDER_TEST } },
          STAMP,
        ),
        "claude.auth.rfc8707-resource-canonical",
      ).status,
    ).toBe("satisfied");
  });
});

describe("a refused resource_metadata pointer is reported, not swallowed", () => {
  it("fails discovery even when the well-known fallback worked", () => {
    // The fallback found the document, and the server still published a
    // pointer no conforming client can follow. Reporting only the success
    // would hide a defect that breaks every client which trusts the challenge.
    const finding = byId(
      runClaudeAuthChecks(
        {
          ...HEALTHY,
          prm: {
            ...HEALTHY.prm!,
            discoveredVia: "well-known-path-suffixed",
            rejectedPointer: "https://elsewhere.example/prm.json",
          },
        },
        STAMP,
      ),
      "claude.auth.prm-discoverable",
    );
    expect(finding.status).toBe("violated");
    expect(finding.details).toMatchObject({
      rejectedPointer: "https://elsewhere.example/prm.json",
    });
  });

  it("passes when the pointer was followed normally", () => {
    expect(
      byId(runClaudeAuthChecks(HEALTHY, STAMP), "claude.auth.prm-discoverable")
        .status,
    ).toBe("satisfied");
  });
});

describe("canonicalResourceIndicator", () => {
  it("drops the query, fragment and default port but keeps the path", () => {
    expect(
      canonicalResourceIndicator("https://MCP.Example.com:443/mcp?x=1#frag"),
    ).toBe("https://mcp.example.com/mcp");
  });

  it("keeps a non-default port", () => {
    expect(canonicalResourceIndicator("https://mcp.example.com:8443/mcp")).toBe(
      "https://mcp.example.com:8443/mcp",
    );
  });

  it("does not invent a trailing slash on an origin-only URL", () => {
    expect(canonicalResourceIndicator("https://mcp.example.com")).toBe(
      "https://mcp.example.com",
    );
  });
});

describe("insufficient_scope challenges", () => {
  it("passes when `scope` is omitted — Claude selects scopes itself", () => {
    const finding = byId(
      runClaudeAuthChecks(
        {
          ...HEALTHY,
          insufficientScopeChallenge: {
            header: 'Bearer error="insufficient_scope"',
          },
        },
        STAMP,
      ),
      "claude.auth.insufficient-scope-challenge-shape",
    );
    expect(finding.status).toBe("satisfied");
    expect(finding.details).toMatchObject({ scopeOmitted: true });
  });

  it("fails when the error code is something else entirely", () => {
    expect(
      byId(
        runClaudeAuthChecks(
          {
            ...HEALTHY,
            insufficientScopeChallenge: { header: 'Bearer error="invalid_token"' },
          },
          STAMP,
        ),
        "claude.auth.insufficient-scope-challenge-shape",
      ).status,
    ).toBe("violated");
  });
});

describe("WWW-Authenticate on a successful response", () => {
  it("is not applicable when the probed response was the 401 itself", () => {
    expect(
      byId(
        runClaudeAuthChecks(HEALTHY, STAMP),
        "claude.auth.no-challenge-on-successful-operation",
      ).status,
    ).toBe("not-applicable");
  });

  it("fails only when a protected operation both succeeded and challenged", () => {
    const output = runClaudeAuthChecks(
      {
        ...HEALTHY,
        unauthenticated: {
          status: 200,
          wwwAuthenticate: 'Bearer realm="api"',
          representsProtectedOperation: true,
          servedWithoutCredentials: true,
        },
      },
      STAMP,
    );
    expect(
      byId(output, "claude.auth.no-challenge-on-successful-operation").status,
    ).toBe("violated");
  });

  it("passes a success with no challenge attached", () => {
    expect(
      byId(
        runClaudeAuthChecks(
          {
            ...HEALTHY,
            unauthenticated: {
              status: 200,
              representsProtectedOperation: true,
              servedWithoutCredentials: true,
            },
          },
          STAMP,
        ),
        "claude.auth.no-challenge-on-successful-operation",
      ).status,
    ).toBe("satisfied");
  });
});

describe("classify, don't fail", () => {
  it("treats an authless server as inapplicable rather than broken", () => {
    const output = runClaudeAuthChecks(
      {
        enteredUrl: URL_UNDER_TEST,
        unauthenticated: {
          status: 200,
          representsProtectedOperation: true,
          servedWithoutCredentials: true,
        },
        prm: { discoveredVia: "not-found" },
      },
      STAMP,
    );
    expect(output.findings.filter((f) => f.status === "violated")).toEqual([]);
    expect(
      byId(output, "claude.auth.unauthenticated-challenge").status,
    ).toBe("not-applicable");
  });

  it("says a static-header connector is indistinguishable rather than guessing", () => {
    const output = runClaudeAuthChecks(
      {
        enteredUrl: URL_UNDER_TEST,
        unauthenticated: {
          status: 200,
          representsProtectedOperation: true,
          servedWithoutCredentials: true,
        },
        prm: { discoveredVia: "not-found" },
        declaredAuthMode: "static-header",
      },
      STAMP,
    );
    const mode = badge(output, "claude.auth.mode");
    expect(mode.state).toBe("claimed");
    expect(mode.detail).toMatch(/static-header/);
  });

  it("accepts a preregistered client when the submitter declared one", () => {
    const noRegistration: ClaudeAuthEvidence = {
      ...HEALTHY,
      declaredAuthMode: "oauth-preregistered",
      firstAuthorizationServer: {
        ...HEALTHY.firstAuthorizationServer!,
        document: {
          issuer: "https://auth.example.com",
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
        },
      },
    };
    expect(
      byId(runClaudeAuthChecks(noRegistration, STAMP), "claude.auth.client-acquisition-path")
        .status,
    ).toBe("satisfied");
  });

  it("flags an undeclared server with no client-acquisition path at all", () => {
    const finding = byId(
      runClaudeAuthChecks(
        {
          ...HEALTHY,
          firstAuthorizationServer: {
            ...HEALTHY.firstAuthorizationServer!,
            document: {
              issuer: "https://auth.example.com",
              code_challenge_methods_supported: ["S256"],
              response_types_supported: ["code"],
            },
          },
        },
        STAMP,
      ),
      "claude.auth.client-acquisition-path",
    );
    expect(finding.status).toBe("violated");
    // …and the remediation names the declaration that would reclassify it.
    expect(finding.remediation).toMatch(/oauth-preregistered/);
  });
});

describe("PKCE and CIMD metadata", () => {
  function withAsDocument(document: Record<string, unknown>) {
    return runClaudeAuthChecks(
      {
        ...HEALTHY,
        firstAuthorizationServer: { ...HEALTHY.firstAuthorizationServer!, document },
      },
      STAMP,
    );
  }

  it("requires S256 to be advertised", () => {
    expect(
      byId(
        withAsDocument({
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["plain"],
          response_types_supported: ["code"],
        }),
        "claude.auth.pkce-s256-advertised",
      ).status,
    ).toBe("violated");
  });

  it("does not grade CIMD when the server never advertises it", () => {
    expect(
      byId(
        withAsDocument({
          registration_endpoint: "https://auth.example.com/register",
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
        }),
        "claude.auth.cimd-flag-consistent",
      ).status,
    ).toBe("not-applicable");
  });

  it("rejects a stringly-typed CIMD flag", () => {
    expect(
      byId(
        withAsDocument({
          client_id_metadata_document_supported: "true",
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["code"],
        }),
        "claude.auth.cimd-flag-consistent",
      ).status,
    ).toBe("violated");
  });

  it("rejects CIMD advertised without the code flow it would use", () => {
    expect(
      byId(
        withAsDocument({
          client_id_metadata_document_supported: true,
          code_challenge_methods_supported: ["S256"],
          response_types_supported: ["token"],
        }),
        "claude.auth.cimd-flag-consistent",
      ).status,
    ).toBe("violated");
  });
});

describe("the JWT audience is evidence, never a verdict", () => {
  it("records a non-matching audience without failing anything", () => {
    const finding = byId(
      runClaudeAuthChecks(
        { ...HEALTHY, accessTokenAudience: ["https://api.internal/graph"] },
        STAMP,
      ),
      "claude.auth.access-token-audience",
    );
    expect(finding.status).toBe("informational");
    expect(finding.class).toBe("manual-review");
    expect(finding.lane).toBe("experience-insights");
    expect(finding.remediation).toMatch(/opaque tokens/);
  });

  it("is not applicable when there was no JWT to read", () => {
    expect(
      byId(runClaudeAuthChecks(HEALTHY, STAMP), "claude.auth.access-token-audience")
        .status,
    ).toBe("not-applicable");
  });
});

describe("an unreachable host is not a connector that broke a rule", () => {
  // Both statuses are `not-found`; only one of them is the server's fault.
  const unreachable: ClaudeAuthEvidence = {
    enteredUrl: URL_UNDER_TEST,
    // No probe completed — the transport never got an answer.
    prm: {
      discoveredVia: "not-found",
      fetchError: "fetch failed",
      reachedServer: false,
    },
  };

  it("reports PRM discovery unevaluated when nothing answered", () => {
    const output = runClaudeAuthChecks(unreachable, STAMP);
    const discoverable = byId(output, "claude.auth.prm-discoverable");
    expect(discoverable.status).toBe("not-evaluated");
    // The reason has to carry the transport error, or the reader is left to
    // guess whether the host is down, firewalled, or simply misspelled.
    expect(discoverable.notEvaluatedReason).toMatch(/fetch failed/);
    expect(
      byId(output, "claude.auth.prm-resource-matches-entered-url").status,
    ).toBe("not-evaluated");
  });

  it("still fails a server that answered and published nothing", () => {
    const answered = runClaudeAuthChecks(
      {
        ...unreachable,
        prm: {
          discoveredVia: "not-found",
          fetchError: "https://mcp.example.com/.well-known/… answered 404",
          reachedServer: true,
        },
      },
      STAMP,
    );
    expect(byId(answered, "claude.auth.prm-discoverable").status).toBe(
      "violated",
    );
  });

  it("grades evidence that predates the field by the stricter reading", () => {
    // `reachedServer: undefined` means the evidence did not record it. Treating
    // that as "unreachable" would turn every hand-built fixture into a pass.
    const legacy = runClaudeAuthChecks(
      { enteredUrl: URL_UNDER_TEST, prm: { discoveredVia: "not-found" } },
      STAMP,
    );
    expect(byId(legacy, "claude.auth.prm-discoverable").status).toBe("violated");
  });
});

describe("a refused issuer is reported as a metadata defect, not an outage", () => {
  it("names the refusal in the remediation", () => {
    const finding = byId(
      runClaudeAuthChecks(
        {
          ...HEALTHY,
          firstAuthorizationServer: {
            issuer: "http://169.254.169.254/",
            reachable: false,
            fetchError: "issuer must be an https URL",
            rejected: "issuer must be an https URL",
          },
        },
        STAMP,
      ),
      "claude.auth.first-authorization-server-usable",
    );
    expect(finding.status).toBe("violated");
    // "Unreachable" would send the submitter to look at DNS and firewalls for
    // a problem with what their own metadata says.
    expect(finding.remediation).toMatch(/no conforming client will fetch/);
    expect(finding.details?.rejected).toBe("issuer must be an https URL");
  });

  it("keeps the plain wording when the fetch was tried and failed", () => {
    const finding = byId(
      runClaudeAuthChecks(
        {
          ...HEALTHY,
          firstAuthorizationServer: {
            issuer: "https://auth.example.com",
            reachable: false,
            fetchError: "connect ETIMEDOUT",
          },
        },
        STAMP,
      ),
      "claude.auth.first-authorization-server-usable",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).not.toMatch(/no conforming client/);
  });
});
