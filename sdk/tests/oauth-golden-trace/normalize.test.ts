import {
  NORMALIZER_VERSION,
  assertTraceIsRedacted,
  extractLoopbackPorts,
  findRedactionViolations,
  normalizeBody,
  normalizeHeaders,
  normalizeLoopbackPort,
  normalizeUrl,
} from "../../src/oauth-golden-trace/index.js";
import type { GoldenTrace } from "../../src/oauth-golden-trace/index.js";
import { parseTraceBody } from "../../src/oauth-golden-trace/index.js";

const OPTIONS = {
  mcpServerUrl: "https://mcp.example.test/mcp",
  authorizationServerUrl: "https://as.example.test",
};

describe("normalizeUrl", () => {
  it("substitutes origins so traces are host-independent", () => {
    const { url } = normalizeUrl(
      "https://as.example.test/.well-known/oauth-authorization-server",
      OPTIONS,
    );
    expect(url).toBe("{as}/.well-known/oauth-authorization-server");
  });

  it("keeps repeated params as separate values", () => {
    // Whether a client emits `resource` once or twice on /authorize is an open
    // question a trace is meant to SETTLE; a single-valued map would answer it
    // wrongly and silently.
    const { query } = normalizeUrl(
      "https://as.example.test/authorize?resource=https%3A%2F%2Fa.test%2Fmcp&resource=https%3A%2F%2Fb.test%2Fmcp",
      OPTIONS,
    );
    expect(query?.resource).toEqual(["https://a.test/mcp", "https://b.test/mcp"]);
  });

  it("placeholds state with length only, and PKCE with length and charset", () => {
    const { query } = normalizeUrl(
      "https://as.example.test/authorize?state=Ux30hX8S90RxBF4a&code_challenge=" +
        "a".repeat(43) +
        "&code_challenge_method=S256",
      OPTIONS,
    );
    // Charset for `state` is inferred from a random draw and is NOT stable across
    // runs, so only the length is kept. See VOLATILE_KEYS.
    expect(query?.state).toEqual(["{state:len=16}"]);
    // For PKCE the alphabet is fixed by RFC 7636, so charset is deterministic and
    // len=43 still proves S256 over a 32-byte verifier.
    expect(query?.code_challenge).toEqual([
      "{code_challenge:len=43,charset=base64url}",
    ]);
    expect(query?.code_challenge_method).toEqual(["S256"]);
  });

  it("keeps a client_id that is a URL, because under CIMD that IS the identity", () => {
    const { query } = normalizeUrl(
      "https://as.example.test/authorize?client_id=https%3A%2F%2Fvendor.test%2Fclient-metadata.json",
      OPTIONS,
    );
    expect(query?.client_id).toEqual(["https://vendor.test/client-metadata.json"]);
  });

  it("placeholds an opaque server-issued client_id", () => {
    const { query } = normalizeUrl(
      "https://as.example.test/authorize?client_id=abc123def456",
      OPTIONS,
    );
    expect(query?.client_id).toEqual(["{client_id}"]);
  });

  it("canonicalizes param order so two recordings of one request match", () => {
    const first = normalizeUrl(
      "https://as.example.test/authorize?b=2&a=1",
      OPTIONS,
    );
    const second = normalizeUrl(
      "https://as.example.test/authorize?a=1&b=2",
      OPTIONS,
    );
    expect(second.url).toBe(first.url);
    expect(JSON.stringify(second.query)).toBe(JSON.stringify(first.query));
  });
});

describe("loopback ports", () => {
  it("placeholds the port so ephemeral-port runs diff clean", () => {
    expect(normalizeLoopbackPort("http://127.0.0.1:54321/callback")).toBe(
      "http://127.0.0.1:{port}/callback",
    );
    expect(normalizeLoopbackPort("http://localhost:1456/mcp/oauth/callback")).toBe(
      "http://localhost:{port}/mcp/oauth/callback",
    );
  });

  it("leaves non-loopback hosts alone", () => {
    expect(normalizeLoopbackPort("https://claude.ai:443/api/mcp/auth_callback")).toBe(
      "https://claude.ai:443/api/mcp/auth_callback",
    );
  });

  it("recovers the ports, because the port RANGE is a real per-host fact", () => {
    // Cline scans 1456-1461; that range is evidence and must survive the
    // placeholder.
    expect(
      extractLoopbackPorts([
        "http://127.0.0.1:1456/mcp/oauth/callback",
        "http://127.0.0.1:1457/mcp/oauth/callback",
        "https://claude.ai/api/mcp/auth_callback",
      ]),
    ).toEqual([1456, 1457]);
  });
});

describe("normalizeHeaders", () => {
  it("redacts credential headers and placeholds volatile ones", () => {
    const headers = normalizeHeaders(
      {
        Authorization: "Bearer sk-live-abcdefghijklmnop",
        "Mcp-Session-Id": "sess-9f8e7d6c",
        Date: "Wed, 29 Jul 2026 12:00:00 GMT",
        "MCP-Protocol-Version": "2025-11-25",
        "User-Agent": "Visual Studio Code/1.104.2",
      },
      OPTIONS,
    );

    expect(headers.authorization).toBe("[REDACTED]");
    expect(headers["mcp-session-id"]).toBe("{mcp-session-id}");
    expect(headers.date).toBe("{date}");
    // The two fields the harness exists to capture survive verbatim.
    expect(headers["mcp-protocol-version"]).toBe("2025-11-25");
    expect(headers["user-agent"]).toBe("Visual Studio Code/1.104.2");
  });

  it("keeps the user-agent version by default, because a bump IS drift", () => {
    expect(normalizeHeaders({ "user-agent": "goose/1.4.2" }, OPTIONS)["user-agent"]).toBe(
      "goose/1.4.2",
    );
    expect(
      normalizeHeaders(
        { "user-agent": "goose/1.4.2" },
        { ...OPTIONS, normalizeVersions: true },
      )["user-agent"],
    ).toBe("goose/{version}");
  });

  it("redacts the authorization code out of a 302 Location header", () => {
    // A conformant AS answers /authorize with
    // `302 Location: <redirect_uri>?code=<code>&state=<state>`. Any proxy or
    // server-side capture of a real host records that verbatim, so a URL-valued
    // header has to get the same per-param treatment as a request URL or a live
    // authorization code lands in a committed artifact.
    const headers = normalizeHeaders(
      {
        Location:
          "http://127.0.0.1:33418/callback?code=real-authorization-code-abcdefghijkl&state=Ux30hX8S90RxBF4a&iss=https://as.example.test",
      },
      OPTIONS,
    );

    expect(headers.location).toContain("code=[REDACTED]");
    expect(headers.location).not.toContain("real-authorization-code");
    expect(headers.location).toContain("state={state:len=16}");
    // The loopback callback port is placeheld, and the issuer origin abstracted.
    expect(headers.location).toContain("http://127.0.0.1:{port}/callback");
    expect(headers.location).toContain("iss={as}");
  });

  it("origin-substitutes inside www-authenticate", () => {
    const headers = normalizeHeaders(
      {
        "WWW-Authenticate":
          'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
      },
      OPTIONS,
    );
    expect(headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="{mcp_server}/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe("normalizeBody", () => {
  it("redacts secrets in a form body but keeps behavioral fields", () => {
    const body = normalizeBody(
      {
        encoding: "form",
        fields: {
          grant_type: ["authorization_code"],
          code: ["real-authorization-code-value"],
          code_verifier: ["real-verifier-value-abcdefghijklmnop"],
          resource: ["https://mcp.example.test/mcp"],
        },
      },
      OPTIONS,
    );

    expect(body).toEqual({
      encoding: "form",
      fields: {
        code: ["[REDACTED]"],
        code_verifier: ["[REDACTED]"],
        grant_type: ["authorization_code"],
        resource: ["{mcp_server}/mcp"],
      },
    });
  });

  it("normalizes timestamps in a JSON body", () => {
    const body = normalizeBody(
      {
        encoding: "json",
        json: { client_id: "abc123", client_id_issued_at: 1800000000, iat: 17 },
      },
      OPTIONS,
    );
    expect(body).toEqual({
      encoding: "json",
      json: {
        client_id: "{client_id}",
        // Any numeric `*_at` / `iat` / `exp` key collapses to one `{timestamp}`
        // placeholder — the specific epoch is never behavioral.
        client_id_issued_at: "{timestamp}",
        iat: "{timestamp}",
      },
    });
  });

  it("stabilizes the JSON-RPC id", () => {
    const body = normalizeBody(
      { encoding: "jsonrpc", method: "initialize", json: { jsonrpc: "2.0", id: 7 } },
      OPTIONS,
    );
    expect(body).toEqual({
      encoding: "jsonrpc",
      method: "initialize",
      json: { jsonrpc: "2.0", id: "{id}" },
    });
  });
});

describe("parseTraceBody", () => {
  it("treats an object with a form content-type as a form body", () => {
    // The SDK's own token requests arrive as objects with this content-type;
    // encoding them as `json` would make them fail to match a HAR of the very
    // same bytes.
    expect(
      parseTraceBody(
        { grant_type: "authorization_code", resource: "https://a.test/mcp" },
        { "content-type": "application/x-www-form-urlencoded" },
      ),
    ).toEqual({
      encoding: "form",
      fields: {
        grant_type: ["authorization_code"],
        resource: ["https://a.test/mcp"],
      },
    });
  });

  it("lets the payload shape win when the content-type disagrees", () => {
    expect(
      parseTraceBody('{"client_name":"Cline"}', {
        "content-type": "text/plain",
      }),
    ).toEqual({ encoding: "json", json: { client_name: "Cline" } });
  });

  it("records an unparseable body as opaque rather than guessing", () => {
    const body = parseTraceBody("<html><body>Consent</body></html>", {
      "content-type": "text/html",
    });
    expect(body?.encoding).toBe("opaque");
  });
});

describe("redaction assertion", () => {
  function traceWith(headers: Record<string, string>): GoldenTrace {
    return {
      traceVersion: 1,
      traceId: "test/scenario/2026-07-29/real-host",
      subject: {
        kind: "real-host",
        hostId: "test",
        hostVersion: { state: "present", value: "1.0.0" },
        oauthImplementation: { state: "present", value: { kind: "first-party" } },
      },
      scenario: {
        scenarioId: "scenario",
        mcpServerUrl: OPTIONS.mcpServerUrl,
        capabilities: {
          publishesPrm: true,
          supportsDcr: true,
          supportsCimd: false,
          codeChallengeMethods: ["S256"],
          asMetadataDocuments: [],
          challengesUnauthenticated: true,
        },
      },
      capture: {
        capturedAt: "2026-07-29",
        method: { via: "har" },
        redaction: { applied: true, normalizerVersion: NORMALIZER_VERSION },
      },
      wire: [
        {
          ordinal: 0,
          leg: "mcp-authenticated",
          request: { method: "POST", url: "{mcp_server}/mcp", headers },
        },
      ],
      observations: {
        legOrder: ["mcp-authenticated"],
        endpointsHit: ["{mcp_server}/mcp"],
        discoveryLadder: [],
        userAgent: { byLeg: {}, consistent: true },
        resourceIndicator: {
          onAuthorize: { state: "not-observed", reason: "n/a" },
          onToken: { state: "not-observed", reason: "n/a" },
          onRefresh: { state: "not-observed", reason: "n/a" },
          valueSource: { state: "not-observed", reason: "n/a" },
        },
        protocolVersion: {
          initializeBody: { state: "not-observed", reason: "n/a" },
          headerByLeg: {},
          headerOnOAuthDiscovery: { state: "not-observed", reason: "n/a" },
          headerOnMcpTraffic: { state: "not-observed", reason: "n/a" },
          wiresDisagree: false,
          headerDisagreesWithInitializeBody: false,
        },
        dcrIdentity: {
          clientName: { state: "not-observed", reason: "n/a" },
          redirectUris: { state: "not-observed", reason: "n/a" },
          observedLoopbackPorts: { state: "not-observed", reason: "n/a" },
          grantTypes: { state: "not-observed", reason: "n/a" },
          responseTypes: { state: "not-observed", reason: "n/a" },
          tokenEndpointAuthMethod: { state: "not-observed", reason: "n/a" },
          scope: { state: "not-observed", reason: "n/a" },
          extraFields: { state: "not-observed", reason: "n/a" },
        },
        pkce: {
          challengeMethod: { state: "not-observed", reason: "n/a" },
          challengeLength: { state: "not-observed", reason: "n/a" },
          verifierSentOnToken: { state: "not-observed", reason: "n/a" },
        },
      },
    };
  }

  it("does NOT flag an RFC 6750 challenge as a credential", () => {
    // `WWW-Authenticate: Bearer resource_metadata="…"` is auth-param syntax, not
    // a token. Without the `key=` lookahead every PRM-publishing server's 401
    // would trip the assertion — which it did, on the first real capture.
    const trace = traceWith({
      "www-authenticate": 'Bearer resource_metadata="{mcp_server}/.well-known/x"',
    });
    expect(findRedactionViolations(trace)).toEqual([]);
    expect(() => assertTraceIsRedacted(trace)).not.toThrow();
  });

  it("flags a leaked bearer token", () => {
    const trace = traceWith({ authorization: "Bearer sk-live-9f8e7d6c5b4a3210" });
    const violations = findRedactionViolations(trace);
    expect(violations.length).toBeGreaterThan(0);
    expect(() => assertTraceIsRedacted(trace)).toThrow(/possible live secret/);
  });

  it("flags a leaked JWT", () => {
    const trace = traceWith({
      "x-custom": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    });
    expect(() => assertTraceIsRedacted(trace)).toThrow(/JWT/);
  });
});
