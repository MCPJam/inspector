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
 * Both now fail closed for the eras governed by the current profile. The
 * debugger keeps the old behavior, but only by passing
 * `requiredMetadataEnforcement: "observe"` — an explicit non-connect intent.
 */

import {
  describePkceMetadataNonConformance,
  selectAuthorizationServerFromResourceMetadata,
  usesCurrentRequiredMetadataProfile,
} from "../../src/oauth/state-machines/shared/required-metadata.js";
import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type {
  OAuthFlowState,
  OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";

const SERVER_URL = "https://mcp.example.com/mcp";
const REDIRECT_URI = "http://127.0.0.1:3333/callback";

/** Eras governed by the current protected-resource + PKCE profile. */
const CURRENT_ERAS: OAuthProtocolVersion[] = ["2025-11-25", "2026-07-28"];
const ALL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  ...CURRENT_ERAS,
];

describe("required-metadata policy", () => {
  it.each(ALL_VERSIONS)("scopes the current profile correctly (%s)", (version) => {
    expect(usesCurrentRequiredMetadataProfile(version)).toBe(
      CURRENT_ERAS.includes(version),
    );
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

const CONFORMING_AS_METADATA = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

describe.each(CURRENT_ERAS)("PKCE metadata verification (%s)", (version) => {
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
    expect(getState().error ?? "").toMatch(/^Warning:/);
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
