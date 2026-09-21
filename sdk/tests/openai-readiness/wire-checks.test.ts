/**
 * The wire lanes: endpoint, authorization, annotations, domain verification.
 *
 * The cases worth writing here are the ones where a plausible implementation is
 * WRONG rather than broken:
 *
 *   - a redirect chain that downgrades in the middle and recovers looks perfect
 *     from its destination;
 *   - an authless server is a legitimate shape, so every OAuth requirement must
 *     be `not-applicable` rather than unmet;
 *   - a multi-issuer server is healthy on issuer zero and unusable on issuer
 *     one, which is exactly the case Claude's runner deliberately does not
 *     look at;
 *   - a self-declared verification token is not proof of anything, so a run
 *     with no token must not pass on the strength of "something answered".
 */

import { describe, expect, it } from "vitest";

import {
  runOpenAIAnnotationChecks,
  annotatedToolNames,
  type OpenAIToolEvidence,
} from "../../src/openai-readiness/checks/annotations.js";
import { runOpenAIAuthChecks } from "../../src/openai-readiness/checks/auth.js";
import { runOpenAIDomainVerificationChecks } from "../../src/openai-readiness/checks/domain-verification.js";
import { runOpenAIEndpointChecks } from "../../src/openai-readiness/checks/endpoint.js";
import type {
  OpenAIAuthEvidence,
  OpenAIEndpointEvidence,
} from "../../src/openai-readiness/discovery.js";
import type { OpenAIReadinessFinding } from "../../src/openai-readiness/types.js";

const STAMP = { evaluatedAt: "2026-08-19T12:00:00.000Z" };

const byId = (findings: OpenAIReadinessFinding[], id: string) =>
  findings.find((finding) => finding.id === id)!;

// ---------------------------------------------------------------- endpoint

function endpoint(
  overrides: Partial<OpenAIEndpointEvidence> = {},
): OpenAIEndpointEvidence {
  return {
    enteredUrl: "https://plugin.example.com/mcp",
    redirectChain: [{ url: "https://plugin.example.com/mcp", status: 200 }],
    ...overrides,
  };
}

describe("endpoint", () => {
  it("passes a clean HTTPS endpoint on the documented path", () => {
    const findings = runOpenAIEndpointChecks(endpoint(), STAMP);
    expect(byId(findings, "openai.endpoint.https").status).toBe("satisfied");
    expect(byId(findings, "openai.endpoint.path").status).toBe("satisfied");
  });

  it("does not report a path violation for a URL that has no path", () => {
    // An unparseable URL has no path to compare. Grading it `violated` prints
    // `path: undefined` and sends the submitter to fix a path when the URL
    // itself is the problem — which the reachability checks already say, in
    // the right words.
    const findings = runOpenAIEndpointChecks(
      endpoint({ enteredUrl: "not a url", redirectChain: [] }),
      STAMP,
    );
    const path = byId(findings, "openai.endpoint.path");
    expect(path.status).toBe("not-evaluated");
    expect(path.notEvaluatedReason).toContain("parseable");
  });

  it("treats a plaintext endpoint as a runtime blocker, not a policy item", () => {
    const findings = runOpenAIEndpointChecks(
      endpoint({
        enteredUrl: "http://plugin.example.com/mcp",
        redirectChain: [{ url: "http://plugin.example.com/mcp", status: 200 }],
      }),
      STAMP,
    );
    const https = byId(findings, "openai.endpoint.https");
    expect(https.status).toBe("violated");
    // Not `required`: this fails before policy is reached, and the distinction
    // is what lets a report explain why nothing else was graded.
    expect(https.class).toBe("runtime-blocker");
  });

  it("catches a downgrade in the MIDDLE of a chain that recovers", () => {
    // Invisible from the destination alone, which is the whole reason the trace
    // records every hop instead of reporting where it landed.
    const findings = runOpenAIEndpointChecks(
      endpoint({
        redirectChain: [
          {
            url: "https://plugin.example.com/mcp",
            status: 302,
            location: "http://plugin.example.com/relay",
          },
          {
            url: "http://plugin.example.com/relay",
            status: 302,
            location: "https://plugin.example.com/mcp2",
          },
          { url: "https://plugin.example.com/mcp2", status: 200 },
        ],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.endpoint.redirects-stay-https").status).toBe(
      "violated",
    );
  });

  it("reports an unterminated chain", () => {
    const findings = runOpenAIEndpointChecks(
      endpoint({
        redirectChain: [
          { url: "https://a.example.com/", status: 302, location: "/b" },
        ],
        redirectLimitHit: true,
      }),
      STAMP,
    );
    expect(byId(findings, "openai.endpoint.redirects-terminate").status).toBe(
      "violated",
    );
  });

  it("does not fail an endpoint on a non-standard path", () => {
    // `/mcp` is what a reviewer expects; another path works. Grading it
    // `required` would fail a submission that is going to be accepted.
    const findings = runOpenAIEndpointChecks(
      endpoint({
        enteredUrl: "https://plugin.example.com/api/mcp-endpoint",
        redirectChain: [
          { url: "https://plugin.example.com/api/mcp-endpoint", status: 200 },
        ],
      }),
      STAMP,
    );
    const path = byId(findings, "openai.endpoint.path");
    expect(path.status).toBe("violated");
    expect(path.class).toBe("recommended");
  });

  it("names the input when no endpoint was supplied", () => {
    const findings = runOpenAIEndpointChecks(undefined, STAMP);
    expect(
      findings.every((finding) => finding.status === "not-evaluated"),
    ).toBe(true);
    expect(
      (findings[0].details as { missingInput?: string })?.missingInput,
    ).toBe("serverUrl");
  });
});

// -------------------------------------------------------------------- auth

function authEvidence(
  overrides: Partial<OpenAIAuthEvidence> = {},
): OpenAIAuthEvidence {
  return {
    enteredUrl: "https://plugin.example.com/mcp",
    unauthenticated: {
      status: 401,
      wwwAuthenticate:
        'Bearer resource_metadata="https://plugin.example.com/.well-known/oauth-protected-resource/mcp"',
    },
    prm: {
      discoveredVia: "well-known-path-suffixed",
      url: "https://plugin.example.com/.well-known/oauth-protected-resource/mcp",
      document: {
        resource: "https://plugin.example.com/mcp",
        authorization_servers: ["https://auth.example.com"],
      },
    },
    authorizationServers: [
      {
        issuer: "https://auth.example.com",
        metadataUrl:
          "https://auth.example.com/.well-known/oauth-authorization-server",
        document: {
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          registration_endpoint: "https://auth.example.com/register",
          grant_types_supported: ["authorization_code", "refresh_token"],
        },
      },
    ],
    advertisedAuthorizationServerCount: 1,
    ...overrides,
  };
}

describe("auth", () => {
  it("passes a conforming single-issuer server", () => {
    const findings = runOpenAIAuthChecks(authEvidence(), STAMP);
    for (const id of [
      "openai.auth.challenge",
      "openai.auth.prm-discoverable",
      "openai.auth.issuers-resolve",
      "openai.auth.pkce-s256",
      "openai.auth.client-acquisition",
      "openai.auth.unsupported-flows",
    ]) {
      expect(byId(findings, id).status, id).toBe("satisfied");
    }
  });

  it("does not demand a PRM document from a host it never reached", () => {
    // `discoveredVia: "not-found"` is recorded both when the well-known path
    // answered 404 and when nothing answered at all, and only the first is a
    // missing document. The endpoint's own probe is the tell: status 0 means
    // the PRM requests went to the same host over the same transport and failed
    // the same way, so this run established nothing. Telling a submitter to
    // publish a document they may already have published — as a `violated`
    // runtime-blocker, no less — is the cardinal sin this lane names in its own
    // comments.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        unauthenticated: { status: 0, error: "connect ECONNREFUSED" },
        prm: { discoveredVia: "not-found" },
        authorizationServers: [],
      }),
      STAMP,
    );
    const prm = byId(findings, "openai.auth.prm-discoverable");
    expect(prm.status).toBe("not-evaluated");
    expect(prm.status).not.toBe("violated");
  });

  it("still reports a genuinely missing PRM document as a violation", () => {
    // The other side of the same branch: the host answered its 401 perfectly
    // well and simply publishes no metadata. That IS the submission's fault,
    // and softening it would trade one lie for another.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        prm: { discoveredVia: "not-found" },
        authorizationServers: [],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.auth.prm-discoverable").status).toBe(
      "violated",
    );
  });

  it("cites the conformance suite rather than re-deciding a shared rule", () => {
    // Two implementations of "a 401 carries a challenge" are two opinions about
    // the same server, and the first question about a disagreement is which to
    // believe.
    const findings = runOpenAIAuthChecks(authEvidence(), STAMP);
    expect(byId(findings, "openai.auth.challenge").derivedFrom).toContain(
      "oauth-conformance:oauth-401-www-authenticate",
    );
    expect(byId(findings, "openai.auth.pkce-s256").derivedFrom).toContain(
      "oauth-conformance:oauth-pkce-s256",
    );
  });

  it("treats an authless server as a legitimate shape", () => {
    const findings = runOpenAIAuthChecks(
      authEvidence({ unauthenticated: { status: 200 } }),
      STAMP,
    );
    // Not-applicable, not unmet: an authless server has nothing to authorize.
    for (const finding of findings) {
      expect(["not-applicable"], finding.id).toContain(finding.status);
    }
  });

  it("fails when ANY advertised issuer is unusable, not just the first", () => {
    // The case Claude's runner deliberately does not look at: healthy on
    // issuer zero, unusable on issuer one.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        advertisedAuthorizationServerCount: 2,
        authorizationServers: [
          ...authEvidence().authorizationServers!,
          {
            issuer: "https://auth2.example.com",
            metadataUrl: "https://auth2.example.com/.well-known/x",
            fetchError: "404",
          },
        ],
      }),
      STAMP,
    );
    const resolve = byId(findings, "openai.auth.issuers-resolve");
    expect(resolve.status).toBe("violated");
    expect(resolve.remediation).toContain("auth2.example.com");
    expect(resolve.remediation).not.toContain("//auth.example.com");
  });

  it("will not say EVERY issuer is fine having read five of two hundred", () => {
    // The issuer fetch is BOUNDED, because `authorization_servers` is a list
    // the submitted server chose. A clean result over the issuers this run
    // read is not a clean result over the ones it did not, and reporting it as
    // one would let a server advertising two hundred issuers pass "every
    // advertised authorization server publishes usable metadata" on the
    // strength of five.
    const findings = runOpenAIAuthChecks(
      authEvidence({ advertisedAuthorizationServerCount: 200 }),
      STAMP,
    );
    for (const id of [
      "openai.auth.issuers-resolve",
      "openai.auth.pkce-s256",
      "openai.auth.rfc9207-iss",
      "openai.auth.unsupported-flows",
    ]) {
      const finding = byId(findings, id);
      expect(finding.status, id).toBe("not-evaluated");
      // The phrase that carries the meaning, not the bare number: "200" alone
      // would equally match a reason mentioning an HTTP 200 or a byte count,
      // so a rewording that dropped the advertised count would still pass.
      expect(finding.notEvaluatedReason, id).toMatch(
        /of the 200 advertised authorization servers/,
      );
    }
  });

  it("still fails on a truncated fetch when what it DID read is broken", () => {
    // Truncation only clouds the clean answer. One unreachable issuer among
    // the five that were read settles the question whatever the other 195 say.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        advertisedAuthorizationServerCount: 200,
        authorizationServers: [
          {
            issuer: "https://auth2.example.com",
            metadataUrl: "https://auth2.example.com/.well-known/x",
            fetchError: "404",
          },
        ],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.auth.issuers-resolve").status).toBe(
      "violated",
    );
  });

  it("does not conclude NO issuer offers registration from a truncated read", () => {
    // The mirror image: "some issuer supports registration" is existential, so
    // it is the NEGATIVE that an unread issuer can overturn.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        advertisedAuthorizationServerCount: 200,
        authorizationServers: [
          {
            issuer: "https://auth.example.com",
            metadataUrl: "https://auth.example.com/.well-known/x",
            document: { code_challenge_methods_supported: ["S256"] },
          },
        ],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.auth.client-acquisition").status).toBe(
      "not-evaluated",
    );
  });

  it("will not pass a feature check over an issuer that published nothing", () => {
    // Every feature check filters to issuers with a document before deciding,
    // so an issuer whose metadata never arrived silently leaves the sample.
    // "No fetched issuer is missing S256", said over a sample of one when two
    // were advertised, is not the claim the check's title makes.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        advertisedAuthorizationServerCount: 2,
        authorizationServers: [
          ...authEvidence().authorizationServers!,
          {
            issuer: "https://auth2.example.com",
            metadataUrl: "https://auth2.example.com/.well-known/x",
            fetchError: "404",
          },
        ],
      }),
      STAMP,
    );
    for (const id of ["openai.auth.pkce-s256", "openai.auth.unsupported-flows"]) {
      const finding = byId(findings, id);
      expect(finding.status, id).toBe("not-evaluated");
      expect(finding.notEvaluatedReason, id).toContain("auth2.example.com");
    }
    // And the check whose whole job is to report those issuers still does.
    expect(byId(findings, "openai.auth.issuers-resolve").status).toBe(
      "violated",
    );
  });

  it("requires RFC 9207 once there is more than one issuer", () => {
    const withoutIss = {
      issuer: "https://auth2.example.com",
      metadataUrl: "https://auth2.example.com/.well-known/x",
      document: {
        code_challenge_methods_supported: ["S256"],
        registration_endpoint: "https://auth2.example.com/register",
      },
    };
    const findings = runOpenAIAuthChecks(
      authEvidence({
        advertisedAuthorizationServerCount: 2,
        authorizationServers: [
          ...authEvidence().authorizationServers!,
          withoutIss,
        ],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.auth.rfc9207-iss").status).toBe("violated");
  });

  it("does not fail a single-issuer server on RFC 9207", () => {
    // With one issuer the parameter is not load-bearing, so failing on it would
    // be inventing a requirement.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        authorizationServers: [
          {
            issuer: "https://auth.example.com",
            metadataUrl: "https://auth.example.com/.well-known/x",
            document: {
              code_challenge_methods_supported: ["S256"],
              registration_endpoint: "https://auth.example.com/register",
            },
          },
        ],
      }),
      STAMP,
    );
    const iss = byId(findings, "openai.auth.rfc9207-iss");
    expect(iss.status).toBe("informational");
  });

  it("accepts Client ID Metadata Documents instead of registration", () => {
    const findings = runOpenAIAuthChecks(
      authEvidence({
        authorizationServers: [
          {
            issuer: "https://auth.example.com",
            metadataUrl: "https://auth.example.com/.well-known/x",
            document: {
              code_challenge_methods_supported: ["S256"],
              authorization_response_iss_parameter_supported: true,
              client_id_metadata_document_supported: true,
              grant_types_supported: ["authorization_code"],
            },
          },
        ],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.auth.client-acquisition").status).toBe(
      "satisfied",
    );
  });

  it("flags an issuer with no authorization-code grant at all", () => {
    const findings = runOpenAIAuthChecks(
      authEvidence({
        authorizationServers: [
          {
            issuer: "https://auth.example.com",
            metadataUrl: "https://auth.example.com/.well-known/x",
            document: {
              code_challenge_methods_supported: ["S256"],
              authorization_response_iss_parameter_supported: true,
              registration_endpoint: "https://auth.example.com/register",
              grant_types_supported: ["client_credentials"],
            },
          },
        ],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.auth.unsupported-flows").status).toBe(
      "violated",
    );
  });

  it("does not flag client_credentials offered ALONGSIDE authorization_code", () => {
    // A server offering both is perfectly usable, and failing it would be a
    // false positive on a very common configuration.
    const findings = runOpenAIAuthChecks(
      authEvidence({
        authorizationServers: [
          {
            issuer: "https://auth.example.com",
            metadataUrl: "https://auth.example.com/.well-known/x",
            document: {
              code_challenge_methods_supported: ["S256"],
              authorization_response_iss_parameter_supported: true,
              registration_endpoint: "https://auth.example.com/register",
              grant_types_supported: [
                "authorization_code",
                "client_credentials",
              ],
            },
          },
        ],
      }),
      STAMP,
    );
    expect(byId(findings, "openai.auth.unsupported-flows").status).toBe(
      "satisfied",
    );
  });

  it("reports an off-origin resource_metadata pointer that was refused", () => {
    const findings = runOpenAIAuthChecks(
      authEvidence({
        prm: {
          ...authEvidence().prm!,
          rejectedPointer: "https://evil.example.net/.well-known/x",
        },
      }),
      STAMP,
    );
    const pointer = byId(findings, "openai.auth.prm-pointer");
    expect(pointer.status).toBe("violated");
    expect(pointer.details?.rejectedPointer).toBe(
      "https://evil.example.net/.well-known/x",
    );
  });

  it("reads a challenge carried in mcp/www_authenticate", () => {
    const findings = runOpenAIAuthChecks(
      authEvidence({
        unauthenticated: {
          status: 401,
          metaWwwAuthenticate:
            'Bearer resource_metadata="https://x/.well-known/y"',
        },
      }),
      STAMP,
    );
    // A runner reading only the HTTP header would report a conforming server
    // as publishing no challenge.
    expect(byId(findings, "openai.auth.challenge").status).toBe("satisfied");
    expect(byId(findings, "openai.auth.runtime-challenge").status).toBe(
      "satisfied",
    );
  });
});

// ------------------------------------------------------------- annotations

const tool = (
  overrides: Partial<OpenAIToolEvidence> = {},
): OpenAIToolEvidence => ({
  name: "get_forecast",
  description: "Look up a forecast",
  inputSchema: { type: "object" },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  ...overrides,
});

describe("annotations", () => {
  it("passes a fully annotated listing", () => {
    const findings = runOpenAIAnnotationChecks([tool()], STAMP);
    expect(byId(findings, "openai.tools.annotations").status).toBe("satisfied");
  });

  it("names the tool and the hint it is missing", () => {
    const findings = runOpenAIAnnotationChecks(
      [tool({ annotations: { readOnlyHint: true } })],
      STAMP,
    );
    const annotations = byId(findings, "openai.tools.annotations");
    expect(annotations.status).toBe("violated");
    expect(annotations.remediation).toContain("get_forecast");
    expect(annotations.remediation).toContain("destructiveHint");
  });

  it("does not treat a missing hint as an implied false", () => {
    // An unannotated tool is unreviewable, not assumed safe.
    const findings = runOpenAIAnnotationChecks(
      [tool({ annotations: {} })],
      STAMP,
    );
    expect(byId(findings, "openai.tools.annotations").status).toBe("violated");
  });

  it("keeps the honesty heuristic out of every verdict", () => {
    const findings = runOpenAIAnnotationChecks(
      [
        tool({
          name: "delete_account",
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        }),
      ],
      STAMP,
    );
    const honesty = byId(findings, "openai.tools.annotation-honesty");
    // Three independent guards: informational status, heuristic class, and a
    // lane that is never dispositive. A name is not a specification.
    expect(honesty.status).toBe("informational");
    expect(honesty.class).toBe("heuristic");
    expect(honesty.lane).toBe("experience-insights");
    expect(honesty.details?.flagged).toEqual(["delete_account"]);
  });

  it("treats a server with no tools as inapplicable, not as a gap", () => {
    const findings = runOpenAIAnnotationChecks([], STAMP);
    expect(
      findings.every((finding) => finding.status === "not-applicable"),
    ).toBe(true);
  });

  it("collects the tools a reviewer will want justified", () => {
    expect(
      annotatedToolNames([
        tool({ name: "a", annotations: { destructiveHint: true } }),
        tool({ name: "b", annotations: { openWorldHint: true } }),
        tool({
          name: "c",
          annotations: { destructiveHint: false, openWorldHint: false },
        }),
      ]),
    ).toEqual(["a", "b"]);
  });
});

// ------------------------------------------------------ domain verification

describe("domain verification", () => {
  const served = {
    url: "https://plugin.example.com/.well-known/openai-apps-challenge",
    status: 200,
    body: "token-abc",
  };

  it("passes when the served body matches the declared token", () => {
    const findings = runOpenAIDomainVerificationChecks(
      { evidence: served, declaredToken: "token-abc" },
      STAMP,
    );
    expect(byId(findings, "openai.domain.challenge-served").status).toBe(
      "satisfied",
    );
    expect(byId(findings, "openai.domain.challenge-matches").status).toBe(
      "satisfied",
    );
  });

  it("never records the token itself in the finding", () => {
    // Findings are rendered into reports and CI logs; a match is the whole fact
    // worth reporting.
    const findings = runOpenAIDomainVerificationChecks(
      { evidence: served, declaredToken: "token-abc" },
      STAMP,
    );
    expect(
      JSON.stringify(byId(findings, "openai.domain.challenge-matches")),
    ).not.toContain("token-abc");
  });

  it("does not pass on the strength of 'something answered'", () => {
    // Without a declared token there is nothing to compare against, and a
    // 200 alone proves only that a path exists.
    const findings = runOpenAIDomainVerificationChecks(
      { evidence: served },
      STAMP,
    );
    expect(byId(findings, "openai.domain.challenge-served").status).toBe(
      "satisfied",
    );
    const matches = byId(findings, "openai.domain.challenge-matches");
    expect(matches.status).toBe("not-evaluated");
    expect((matches.details as { missingInput?: string })?.missingInput).toBe(
      "submissionProfile",
    );
  });

  it("reports a mismatch without echoing either value", () => {
    const findings = runOpenAIDomainVerificationChecks(
      {
        evidence: { ...served, body: "stale-token" },
        declaredToken: "token-abc",
      },
      STAMP,
    );
    const matches = byId(findings, "openai.domain.challenge-matches");
    expect(matches.status).toBe("violated");
    expect(JSON.stringify(matches)).not.toContain("stale-token");
  });

  it("reports a 404 at the challenge path", () => {
    const findings = runOpenAIDomainVerificationChecks(
      { evidence: { ...served, status: 404, body: "" }, declaredToken: "t" },
      STAMP,
    );
    expect(byId(findings, "openai.domain.challenge-served").status).toBe(
      "violated",
    );
  });

  it("keeps an unreachable origin unevaluated rather than failed", () => {
    const findings = runOpenAIDomainVerificationChecks(
      {
        evidence: { url: served.url, fetchError: "ECONNREFUSED" },
        declaredToken: "t",
      },
      STAMP,
    );
    expect(byId(findings, "openai.domain.challenge-served").status).toBe(
      "not-evaluated",
    );
  });

  it("marks the comparison's provenance as declared", () => {
    const findings = runOpenAIDomainVerificationChecks(
      { evidence: served, declaredToken: "token-abc" },
      STAMP,
    );
    // Half this comparison is the submitter's own statement about what the
    // portal issued, and the provenance has to say so.
    expect(byId(findings, "openai.domain.challenge-matches").provenance).toBe(
      "declared",
    );
  });
});
