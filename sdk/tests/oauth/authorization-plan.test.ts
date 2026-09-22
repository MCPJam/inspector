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

  it("does not pre-block preregistered public clients when the AS omits token auth methods", () => {
    // CLI flows (--client-id only against ASes that don't advertise "none")
    // must keep working; the AS itself rejects unauthenticated public-client
    // requests, so a pre-flight block here just breaks otherwise-valid setups.
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationMode: "preregistered",
      clientId: "client-id",
      discovery: {
        authorizationServerMetadata: {},
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.registrationStrategy).toBe("preregistered");
    expect(
      plan.blockerDetails.some(
        (b) => b.code === "PREREGISTERED_MISSING_CLIENT_SECRET",
      ),
    ).toBe(false);
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

  it("permits explicit CIMD on 2026-07-28 (parity with the auto-select gate)", () => {
    // 2026-07-28 advertises CIMD (resolveRegistrationStrategies), so explicitly
    // selecting it must not raise CIMD_UNSUPPORTED_PROTOCOL — otherwise auto and
    // explicit selection disagree.
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      protocolVersion: "2026-07-28",
      registrationStrategy: "cimd",
    });

    expect(
      plan.blockerDetails.some((b) => b.code === "CIMD_UNSUPPORTED_PROTOCOL"),
    ).toBe(false);
  });
});

describe("resolveAuthorizationPlan — emulated client registration preference", () => {
  const discovery = (metadata: Record<string, unknown>) => ({
    authorizationServerMetadata: {
      issuer: "https://as.example.com",
      authorization_endpoint: "https://as.example.com/authorize",
      token_endpoint: "https://as.example.com/token",
      ...metadata,
    },
  });

  it("honors the client's order over the built-in AUTO precedence", () => {
    // AUTO would pick CIMD here; the emulated client prefers DCR.
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationPreference: ["dcr", "cimd"],
      discovery: discovery({
        registration_endpoint: "https://as.example.com/register",
        client_id_metadata_document_supported: true,
      }),
    });

    expect(plan.status).toBe("ready");
    expect(plan.registrationStrategy).toBe("dcr");
  });

  it("skips a preferred mechanism the server does not support and takes the next", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationPreference: ["cimd", "dcr"],
      discovery: discovery({
        registration_endpoint: "https://as.example.com/register",
      }),
    });

    expect(plan.registrationStrategy).toBe("dcr");
    expect(plan.warnings.join(" ")).toMatch(/prefers CIMD/);
  });

  it("skips preferred pre-registration when no credentials are configured", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationPreference: ["preregistered", "dcr"],
      discovery: discovery({
        registration_endpoint: "https://as.example.com/register",
      }),
    });

    expect(plan.registrationStrategy).toBe("dcr");
  });

  it("blocks when no preferred mechanism is usable", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationPreference: ["preregistered", "dcr"],
      discovery: discovery({}),
    });

    expect(plan.status).toBe("blocked");
    expect(
      plan.blockerDetails.some(
        (b) => b.code === "AUTO_NO_USABLE_REGISTRATION_FLOW",
      ),
    ).toBe(true);
  });

  it("asks for discovery rather than guessing support", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationPreference: ["dcr"],
    });

    expect(plan.status).toBe("discovery_required");
  });

  it("an explicit registrationMode still wins over the preference", () => {
    const plan = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationMode: "cimd",
      registrationPreference: ["dcr"],
      discovery: discovery({
        registration_endpoint: "https://as.example.com/register",
        client_id_metadata_document_supported: true,
      }),
    });

    expect(plan.registrationStrategy).toBe("cimd");
  });

  it("an empty preference leaves the built-in AUTO precedence untouched", () => {
    const withEmpty = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      registrationPreference: [],
      discovery: discovery({
        registration_endpoint: "https://as.example.com/register",
        client_id_metadata_document_supported: true,
      }),
    });
    const without = resolveAuthorizationPlan({
      serverUrl: "https://example.com/mcp",
      authMode: "interactive",
      discovery: discovery({
        registration_endpoint: "https://as.example.com/register",
        client_id_metadata_document_supported: true,
      }),
    });

    expect(withEmpty).toEqual(without);
    expect(withEmpty.registrationStrategy).toBe("cimd");
  });
});
