import {
  canonicalizeResourceUrl,
  evaluateResourceIndicator,
  resolveResourceIndicatorValue,
} from "../../src/oauth/resource-policy.js";

const SERVER_URL = "https://mcp.example.com/mcp";

describe("evaluateResourceIndicator", () => {
  it("accepts an exact-match PRM resource", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "https://mcp.example.com/mcp",
    });
    expect(decision).toEqual({
      value: "https://mcp.example.com/mcp",
      source: "prm",
      status: "valid",
      strictClientCompatible: true,
      rfc9728Compliant: true,
    });
  });

  it("accepts a path-prefix PRM resource as strict-compatible", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "https://mcp.example.com",
    });
    expect(decision.status).toBe("valid");
    expect(decision.strictClientCompatible).toBe(true);
    expect(decision.rfc9728Compliant).toBe(true);
    expect(decision.value).toBe("https://mcp.example.com");
  });

  it("echoes a valid advertised value verbatim — no canonicalization rewrites", () => {
    // The AS compares the request's `resource` against what the RS
    // advertised; rewriting (case, trailing slash) risks an invented
    // audience mismatch.
    const decision = evaluateResourceIndicator({
      serverUrl: "https://mcp.example.com/api/mcp",
      prmResource: "HTTPS://MCP.EXAMPLE.COM/api/",
    });
    expect(decision.status).toBe("valid");
    expect(decision.value).toBe("HTTPS://MCP.EXAMPLE.COM/api/");
  });

  it("accepts a same-origin non-prefix resource but flags strict incompatibility (Asana shape)", () => {
    // Real servers advertise a PRM resource on the same host but a different
    // path than the transport endpoint (Asana: /sse transport, /v2/mcp
    // resource). That must stay connectable — same-origin is the security
    // boundary — while the official-SDK strictness gap is reported.
    const decision = evaluateResourceIndicator({
      serverUrl: "https://mcp.asana.com/sse",
      prmResource: "https://mcp.asana.com/v2/mcp",
    });
    expect(decision.status).toBe("valid");
    expect(decision.strictClientCompatible).toBe(false);
    expect(decision.rfc9728Compliant).toBe(false);
    expect(decision.rfc9728Reason).toContain("protected-resource binding");
    expect(decision.value).toBe("https://mcp.asana.com/v2/mcp");
    expect(decision.reason).toContain("path prefix");
  });

  it("flags a trailing-slash-longer path as strict-incompatible (official SDK parity)", () => {
    // checkResourceAllowed in the official MCP SDK rejects `/mcp/` advertised
    // for a `/mcp` server via its raw pathname-length guard; the shared
    // evaluator must agree or the debugger's warnings would lie about what
    // strict clients do.
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "https://mcp.example.com/mcp/",
    });
    expect(decision.status).toBe("valid");
    expect(decision.strictClientCompatible).toBe(false);
    expect(decision.rfc9728Compliant).toBe(false);
  });

  it("rejects a cross-origin https resource as incompatible, value verbatim", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "https://other.example.com/mcp",
    });
    expect(decision.status).toBe("incompatible");
    expect(decision.strictClientCompatible).toBe(false);
    expect(decision.rfc9728Compliant).toBe(false);
    expect(decision.value).toBe("https://other.example.com/mcp");
    expect(decision.reason).toContain("different origin");
  });

  it("marks a URN invalid (RFC 9728 §2) but keeps the verbatim value", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "urn:example:my-resource",
    });
    expect(decision.status).toBe("invalid");
    expect(decision.strictClientCompatible).toBe(false);
    expect(decision.rfc9728Compliant).toBe(false);
    expect(decision.value).toBe("urn:example:my-resource");
    expect(decision.reason).toContain("https URL");
  });

  it("marks a fragment-bearing resource invalid (RFC 8707)", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "https://mcp.example.com/mcp#frag",
    });
    expect(decision.status).toBe("invalid");
  });

  it("marks an unparseable resource invalid without throwing", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "not a uri at all",
    });
    expect(decision.status).toBe("invalid");
    expect(decision.value).toBe("not a uri at all");
  });

  it("keeps same-origin http usable for development but marks it noncompliant", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: "http://localhost:8000/mcp",
      prmResource: "http://localhost:8000/mcp",
    });
    expect(decision.status).toBe("valid");
    expect(decision.strictClientCompatible).toBe(true);
    expect(decision.rfc9728Compliant).toBe(false);
    expect(decision.rfc9728Reason).toContain("https scheme");
    expect(decision.value).toBe("http://localhost:8000/mcp");
  });

  it("rejects an http resource against an https server (scheme is part of origin)", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "http://mcp.example.com/mcp",
    });
    expect(decision.status).toBe("incompatible");
  });

  it("reports an unparseable server URL as an invalid fallback", () => {
    const decision = evaluateResourceIndicator({ serverUrl: "not a url" });
    expect(decision.source).toBe("server");
    expect(decision.status).toBe("invalid");
    expect(decision.strictClientCompatible).toBe(false);
  });

  it("falls back to the canonicalized server URL when nothing is advertised", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: "HTTPS://MCP.EXAMPLE.COM/mcp/",
    });
    expect(decision).toEqual({
      value: "https://mcp.example.com/mcp",
      source: "server",
      status: "valid",
      strictClientCompatible: true,
      rfc9728Compliant: true,
    });
  });

  it("skips blank candidates when picking by precedence", () => {
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "   ",
      configuredResource: "https://mcp.example.com/mcp",
    });
    expect(decision.source).toBe("configured");
    expect(decision.status).toBe("valid");
  });

  it("prefers prm over authorization over configured", () => {
    expect(
      evaluateResourceIndicator({
        serverUrl: SERVER_URL,
        prmResource: "https://mcp.example.com/mcp",
        authorizationUrlResource: "https://mcp.example.com",
        configuredResource: "https://mcp.example.com",
      }).source
    ).toBe("prm");

    expect(
      evaluateResourceIndicator({
        serverUrl: SERVER_URL,
        authorizationUrlResource: "https://mcp.example.com",
        configuredResource: "https://mcp.example.com/mcp",
      }).source
    ).toBe("authorization");
  });

  it("does not fall through to later candidates when the first is broken", () => {
    // A broken advertised value is a finding, not something to paper over.
    const decision = evaluateResourceIndicator({
      serverUrl: SERVER_URL,
      prmResource: "urn:example:broken",
      configuredResource: "https://mcp.example.com/mcp",
    });
    expect(decision.source).toBe("prm");
    expect(decision.status).toBe("invalid");
  });
});

describe("resolveResourceIndicatorValue", () => {
  it("prefers the persisted decision", () => {
    expect(
      resolveResourceIndicatorValue({
        serverUrl: SERVER_URL,
        prmResource: "https://mcp.example.com/mcp",
        resolved: {
          value: "urn:example:persisted",
          source: "prm",
          status: "invalid",
          strictClientCompatible: false,
          rfc9728Compliant: false,
        },
      })
    ).toBe("urn:example:persisted");
  });

  it("re-evaluates lazily when no decision was persisted", () => {
    expect(
      resolveResourceIndicatorValue({
        serverUrl: SERVER_URL,
        prmResource: "urn:example:my-resource",
      })
    ).toBe("urn:example:my-resource");
    expect(resolveResourceIndicatorValue({ serverUrl: SERVER_URL })).toBe(
      SERVER_URL
    );
  });

  it("returns the raw PRM value when no server URL is known", () => {
    expect(
      resolveResourceIndicatorValue({ prmResource: "urn:example:x" })
    ).toBe("urn:example:x");
    expect(resolveResourceIndicatorValue({})).toBeUndefined();
  });
});

describe("canonicalizeResourceUrl", () => {
  it("lowercases scheme/host, strips hash and trailing slash", () => {
    expect(canonicalizeResourceUrl("HTTPS://MCP.Example.COM/Path/#frag")).toBe(
      "https://mcp.example.com/Path"
    );
  });

  it("keeps the root slash and returns unparseable input unchanged", () => {
    expect(canonicalizeResourceUrl("https://mcp.example.com/")).toBe(
      "https://mcp.example.com/"
    );
    expect(canonicalizeResourceUrl("nope")).toBe("nope");
  });
});
