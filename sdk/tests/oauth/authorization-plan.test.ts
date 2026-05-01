import { resolveAuthorizationPlan } from "../../src/oauth/authorization-plan.js";

describe("resolveAuthorizationPlan", () => {
  it("requires discovery before automatic flows can choose CIMD or DCR", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
    });

    expect(plan.status).toBe("discovery_required");
    expect(plan.protocolVersion).toBe("2025-11-25");
    expect(plan.registrationStrategy).toBeUndefined();
  });

  it("prefers preregistered credentials when they are already available", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    expect(plan.status).toBe("ready");
    expect(plan.registrationStrategy).toBe("preregistered");
  });

  it("treats omitted token auth methods as client_secret_basic for preregistered clients", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationMode: "preregistered",
      clientId: "client-id",
      discovery: {
        authorizationServerMetadata: {},
      },
    });

    expect(plan.status).toBe("blocked");
    expect(plan.blockerDetails[0]?.code).toBe(
      "PREREGISTERED_MISSING_CLIENT_SECRET",
    );
    expect(plan.blockers[0]).toContain("requires a client secret");
  });

  it("allows preregistered public clients when the token endpoint supports none", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationMode: "preregistered",
      clientId: "client-id",
      discovery: {
        authorizationServerMetadata: {
          token_endpoint_auth_methods_supported: ["none"],
        },
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.registrationStrategy).toBe("preregistered");
  });

  it("accepts a stored preregistered secret without exposing the value", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationMode: "preregistered",
      clientId: "client-id",
      hasClientSecret: true,
      discovery: {
        authorizationServerMetadata: {},
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.registrationStrategy).toBe("preregistered");
  });

  it("blocks unsupported confidential token endpoint auth methods", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationMode: "preregistered",
      clientId: "client-id",
      clientSecret: "client-secret",
      discovery: {
        authorizationServerMetadata: {
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
        },
      },
    });

    expect(plan.status).toBe("blocked");
    expect(plan.blockers[0]).toContain(
      "Unsupported OAuth client authentication method",
    );
  });

  it("blocks automatic preregistered selection when client_credentials inputs are incomplete", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "client_credentials",
      clientId: "client-id-only",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.registrationStrategy).toBeUndefined();
    expect(plan.blockerDetails[0]?.code).toBe(
      "AUTO_INCOMPLETE_PREREGISTERED_CREDENTIALS",
    );
    expect(plan.blockers[0]).toContain(
      "Provide both a client ID and client secret",
    );
  });

  it("chooses CIMD for latest-spec interactive flows when advertised", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      discovery: {
        authorizationServerMetadata: {
          registration_endpoint: "https://auth.example.com/register",
          client_id_metadata_document_supported: true,
        },
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.registrationStrategy).toBe("cimd");
    expect(plan.capabilities.supportsCimd).toBe(true);
    expect(plan.capabilities.supportsDcr).toBe(true);
  });

  it("falls back to DCR when CIMD is unavailable", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      discovery: {
        authorizationServerMetadata: {
          registration_endpoint: "https://auth.example.com/register",
        },
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.registrationStrategy).toBe("dcr");
  });

  it("blocks automatic client_credentials when only CIMD is available", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "client_credentials",
      discovery: {
        authorizationServerMetadata: {
          client_id_metadata_document_supported: true,
        },
      },
    });

    expect(plan.status).toBe("blocked");
    expect(plan.registrationStrategy).toBeUndefined();
    expect(plan.blockerDetails[0]?.code).toBe(
      "AUTO_NO_CLIENT_CREDENTIALS_COMPATIBLE_FLOW",
    );
    expect(plan.blockers[0]).toContain("client_credentials-compatible flow");
  });

  it("blocks explicit CIMD on pre-2025-11-25 protocol versions", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      protocolVersion: "2025-06-18",
      registrationStrategy: "cimd",
    });

    expect(plan.status).toBe("blocked");
    expect(plan.registrationStrategy).toBe("cimd");
    expect(plan.blockerDetails[0]?.code).toBe("CIMD_UNSUPPORTED_PROTOCOL");
    expect(plan.blockers[0]).toContain("not supported for protocol version 2025-06-18");
  });
});
