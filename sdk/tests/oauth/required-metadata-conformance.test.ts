/**
 * MCP Authorization requires a client to VERIFY certain metadata before it
 * sends a user to an authorization server. Two of those checks used to warn and
 * continue, which means the flow silently proceeded without the protection the
 * check exists to guarantee:
 *
 *   - PKCE: an authorization server whose `code_challenge_methods_supported`
 *     omits S256 was accepted with a console warning.
 *   - Protected-resource metadata: an empty or missing `authorization_servers`
 *     list was replaced by the MCP server's own URL, inventing an authorization
 *     server the resource never named.
 *
 * Both now fail closed, but NOT on the same eras — each is gated on the eras
 * whose spec text actually states the requirement. The PRM rule dates to
 * 2025-06-18; the PKCE rule to 2025-11-25, because 2025-06-18 says nothing
 * about `code_challenge_methods_supported`. The debugger keeps the old
 * behavior, but only by passing `requiredMetadataEnforcement: "observe"` — an
 * explicit non-connect intent.
 */

import {
  describePkceMetadataNonConformance,
  requiresAdvertisedAuthorizationServers,
  requiresAdvertisedS256,
  selectAuthorizationServerFromResourceMetadata,
} from "../../src/oauth/state-machines/shared/required-metadata.js";
import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type {
  OAuthFlowState,
  OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";

const SERVER_URL = "https://mcp.example.com/mcp";
const REDIRECT_URI = "http://127.0.0.1:3333/callback";

/** Eras that require the AS to advertise S256 (PKCE verification). */
const S256_ERAS: OAuthProtocolVersion[] = ["2025-11-25", "2026-07-28"];
/** Eras that require the PRM to name an authorization server (RFC 9728). */
const PRM_ERAS: OAuthProtocolVersion[] = ["2025-06-18", ...S256_ERAS];
const ALL_VERSIONS: OAuthProtocolVersion[] = ["2025-03-26", ...PRM_ERAS];

describe("required-metadata policy", () => {
  // The two gates are deliberately different. 2025-06-18 already said the PRM
  // document MUST name at least one authorization server, but said nothing at
  // all about `code_challenge_methods_supported` — so mirroring the PKCE rule
  // onto it would invent a requirement that revision does not state.
  it.each(ALL_VERSIONS)("gates the PRM rule from 2025-06-18 (%s)", (version) => {
    expect(requiresAdvertisedAuthorizationServers(version)).toBe(
      PRM_ERAS.includes(version),
    );
  });

  it.each(ALL_VERSIONS)("gates the S256 rule from 2025-11-25 (%s)", (version) => {
    expect(requiresAdvertisedS256(version)).toBe(S256_ERAS.includes(version));
  });

  it("leaves PKCE metadata unchecked on eras that never required it", () => {
    for (const version of ["2025-03-26", "2025-06-18"] as const) {
      expect(describePkceMetadataNonConformance([], version)).toBeUndefined();
      expect(
        describePkceMetadataNonConformance(["plain"], version),
      ).toBeUndefined();
    }
  });

  it("permits the authorization-server fallback only on 2025-03-26", () => {
    const selection = selectAuthorizationServerFromResourceMetadata({
      authorizationServers: undefined,
      fallbackServerUrl: SERVER_URL,
      protocolVersion: "2025-03-26",
    });
    expect(selection.substituted).toBe(true);
    expect(selection.authorizationServerUrl).toBe(SERVER_URL);
    expect(selection.error).toBeUndefined();

    // 2025-06-18 carries the same MUST as the later eras, so a version-faithful
    // machine has to flag it there too — otherwise picking 2025-06-18 in the
    // version selector becomes a one-click bypass of a fail-closed check.
    expect(
      selectAuthorizationServerFromResourceMetadata({
        authorizationServers: undefined,
        fallbackServerUrl: SERVER_URL,
        protocolVersion: "2025-06-18",
      }).error,
    ).toContain("authorization_servers");
  });

  it("accepts S256, with or without plain alongside it", () => {
    expect(
      describePkceMetadataNonConformance(["S256"], "2025-11-25"),
    ).toBeUndefined();
    expect(
      describePkceMetadataNonConformance(["plain", "S256"], "2025-11-25"),
    ).toBeUndefined();
  });

  it("rejects an absent list and a list without S256", () => {
    expect(describePkceMetadataNonConformance([], "2025-11-25")).toContain(
      "code_challenge_methods_supported",
    );
    expect(
      describePkceMetadataNonConformance(undefined, "2025-11-25"),
    ).toContain("code_challenge_methods_supported");
    expect(
      describePkceMetadataNonConformance(["plain"], "2025-11-25"),
    ).toContain("S256");
  });

  it("reports the substitution rather than performing it silently", () => {
    expect(
      selectAuthorizationServerFromResourceMetadata({
        authorizationServers: ["https://auth.example.com"],
        fallbackServerUrl: SERVER_URL,
        protocolVersion: "2025-11-25",
      }),
    ).toEqual({
      authorizationServerUrl: "https://auth.example.com",
      substituted: false,
    });

    for (const authorizationServers of [undefined, [], [""], ["  "]]) {
      const selection = selectAuthorizationServerFromResourceMetadata({
        authorizationServers,
        fallbackServerUrl: SERVER_URL,
        protocolVersion: "2025-11-25",
      });
      expect(selection.substituted).toBe(true);
      expect(selection.authorizationServerUrl).toBe(SERVER_URL);
      expect(selection.error).toContain("authorization_servers");
    }
  });
});

/**
 * Drive the machine from the point where authorization-server metadata has just
 * been fetched, so the PKCE verification runs against the seeded document.
 */
function makeMachineAtAsMetadata(
  protocolVersion: OAuthProtocolVersion,
  metadata: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    serverUrl: SERVER_URL,
    currentStep: "request_authorization_server_metadata",
    authorizationServerUrl: "https://auth.example.com",
    resourceMetadata: {
      resource: SERVER_URL,
      authorization_servers: ["https://auth.example.com"],
    },
  } as OAuthFlowState;

  const requestExecutor = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: metadata,
  });

  const machine = createOAuthStateMachine({
    protocolVersion,
    registrationStrategy: "dcr",
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    serverUrl: SERVER_URL,
    serverName: "Test Server",
    redirectUrl: REDIRECT_URI,
    requestExecutor,
    dynamicRegistration: { client_name: "Test Client" },
    ...(extra as never),
  });

  return { machine, getState: () => state, requestExecutor };
}

/**
 * Drive the machine through protected-resource discovery, so the
 * `authorization_servers` check runs against the seeded PRM document.
 */
function makeMachineAtResourceMetadata(
  protocolVersion: OAuthProtocolVersion,
  resourceMetadata: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    serverUrl: SERVER_URL,
    currentStep: "request_resource_metadata",
  } as OAuthFlowState;

  const requestExecutor = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: resourceMetadata,
  });

  const machine = createOAuthStateMachine({
    protocolVersion,
    registrationStrategy: "dcr",
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    serverUrl: SERVER_URL,
    serverName: "Test Server",
    redirectUrl: REDIRECT_URI,
    requestExecutor,
    dynamicRegistration: { client_name: "Test Client" },
    ...(extra as never),
  });

  return { machine, getState: () => state };
}

describe("protected-resource `authorization_servers` verification", () => {
  const advance = async (machine: { proceedToNextStep: () => Promise<void> }) =>
    machine.proceedToNextStep().catch(() => {});

  it.each(PRM_ERAS)("fails closed when no AS is named (%s)", async (version) => {
    const { machine, getState } = makeMachineAtResourceMetadata(version, {
      resource: SERVER_URL,
    });
    await advance(machine);

    expect(getState().error ?? "").toContain("authorization_servers");
    expect(getState().authorizationUrl).toBeFalsy();
  });

  it.each(PRM_ERAS)("proceeds when an AS is named (%s)", async (version) => {
    const { machine, getState } = makeMachineAtResourceMetadata(version, {
      resource: SERVER_URL,
      authorization_servers: ["https://auth.example.com"],
    });
    await advance(machine);

    expect(getState().error ?? "").not.toContain("authorization_servers");
    expect(getState().authorizationServerUrl).toBe("https://auth.example.com");
  });

  it.each(PRM_ERAS)(
    "continues under an explicit observe intent (%s)",
    async (version) => {
      const { machine, getState } = makeMachineAtResourceMetadata(
        version,
        { resource: SERVER_URL },
        { requiredMetadataEnforcement: "observe" },
      );
      await advance(machine);

      // Substituted rather than rejected — but never invisibly.
      expect(getState().authorizationServerUrl).toBe(SERVER_URL);
      expect(
        JSON.stringify(getState().infoLogs ?? []),
      ).toContain("authorization_servers");
    },
  );

  // 2025-03-26 predates the MCP profile's adoption of RFC 9728, so the
  // historical fallback is the version-faithful behavior there.
  it("keeps the silent fallback on 2025-03-26", async () => {
    const { machine, getState } = makeMachineAtResourceMetadata("2025-03-26", {
      resource: SERVER_URL,
    });
    await advance(machine);

    expect(getState().error ?? "").not.toContain("authorization_servers");
  });
});

const CONFORMING_AS_METADATA = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

describe.each(S256_ERAS)("PKCE metadata verification (%s)", (version) => {
  // Exactly one step: the metadata fetch and its verification. Advancing
  // further would reach DCR and overwrite the finding under test.
  const advance = async (machine: { proceedToNextStep: () => Promise<void> }) =>
    machine.proceedToNextStep().catch(() => {});

  it("fails closed when S256 is not advertised", async () => {
    const { machine, getState } = makeMachineAtAsMetadata(version, {
      ...CONFORMING_AS_METADATA,
      code_challenge_methods_supported: ["plain"],
    });
    await advance(machine);

    expect(getState().error ?? "").toContain("S256");
    expect(getState().authorizationUrl).toBeFalsy();
  });

  it("proceeds when S256 is advertised alongside plain", async () => {
    const { machine, getState } = makeMachineAtAsMetadata(version, {
      ...CONFORMING_AS_METADATA,
      code_challenge_methods_supported: ["plain", "S256"],
    });
    await advance(machine);

    expect(getState().error ?? "").not.toContain("S256");
    expect(getState().authorizationServerMetadata).toBeTruthy();
  });

  it("warns and continues only under an explicit observe intent", async () => {
    const { machine, getState } = makeMachineAtAsMetadata(
      version,
      { ...CONFORMING_AS_METADATA, code_challenge_methods_supported: ["plain"] },
      { requiredMetadataEnforcement: "observe" },
    );
    await advance(machine);

    // Still surfaced, but as a warning attached to metadata the flow kept.
    expect(getState().error ?? "").toMatch(/^Warning:|S256/);
    expect(getState().authorizationServerMetadata).toBeTruthy();
  });

  it("still rejects under strictConformance even in observe mode", async () => {
    const { machine, getState } = makeMachineAtAsMetadata(
      version,
      { ...CONFORMING_AS_METADATA, code_challenge_methods_supported: ["plain"] },
      { requiredMetadataEnforcement: "observe", strictConformance: true },
    );
    await advance(machine);

    expect(getState().error ?? "").toContain("S256");
    expect(getState().authorizationServerMetadata).toBeFalsy();
  });
});
