/**
 * Sequence-diagram action goldens.
 *
 * `buildActions_*` is pure presentation — it renders the OAuth ladder for the
 * debugger's sequence diagram and has zero effect on the wire. It was also
 * ~1,700 lines of near-duplicate array literals across four era files, which is
 * the worst ratio in the OAuth code: maximum maintenance cost, zero protocol
 * risk.
 *
 * These snapshots pin the rendered actions for every era × every supported
 * registration strategy, at both an empty flow state and a fully-populated one
 * (the two branches every `details` field takes). Consolidating the builders is
 * only safe if the output does not move, and this is what says so.
 */

import { buildOAuthSequenceActions } from "../../src/oauth/sequence-actions.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";

const ALL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

type Strategy = "dcr" | "preregistered" | "cimd";

const STRATEGIES: Strategy[] = ["dcr", "preregistered", "cimd"];

/** Exercises the "populated" branch of every conditional `details` block. */
const POPULATED_STATE: OAuthFlowState = {
  ...EMPTY_OAUTH_FLOW_STATE,
  currentStep: "complete",
  serverUrl: "https://mcp-server.example.com/mcp",
  resourceMetadataUrl:
    "https://mcp-server.example.com/.well-known/oauth-protected-resource/mcp",
  resourceMetadata: {
    resource: "https://mcp-server.example.com/mcp",
    authorization_servers: ["https://auth-server.example.com"],
    scopes_supported: ["openid", "profile"],
  },
  resourceIndicator: "https://mcp-server.example.com/mcp",
  authorizationServerUrl: "https://auth-server.example.com",
  authorizationServerMetadata: {
    issuer: "https://auth-server.example.com",
    authorization_endpoint: "https://auth-server.example.com/authorize",
    token_endpoint: "https://auth-server.example.com/token",
    registration_endpoint: "https://auth-server.example.com/register",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  },
  recordedIssuer: "https://auth-server.example.com",
  clientId: "https://www.mcpjam.com/.well-known/oauth/client-metadata.json",
  codeVerifier: "golden-code-verifier-value",
  codeChallenge: "golden-code-challenge-value",
  codeChallengeMethod: "S256",
  authorizationUrl:
    "https://auth-server.example.com/authorize?response_type=code&state=golden-state",
  authorizationCode: "golden-authorization-code-value",
  accessToken: "golden-access-token-value",
  tokenType: "Bearer",
  expiresIn: 3600,
  wwwAuthenticateHeader:
    'Bearer resource_metadata="https://mcp-server.example.com/.well-known/oauth-protected-resource/mcp"',
} as OAuthFlowState;

const CASES = ALL_VERSIONS.flatMap((protocolVersion) =>
  STRATEGIES.flatMap((registrationStrategy) =>
    (["empty", "populated"] as const).map(
      (shape) =>
        [protocolVersion, registrationStrategy, shape] as [
          OAuthProtocolVersion,
          Strategy,
          "empty" | "populated",
        ],
    ),
  ),
);

describe.each(CASES)(
  "sequence actions (%s / %s / %s state)",
  (protocolVersion, registrationStrategy, shape) => {
    const flowState =
      shape === "populated"
        ? POPULATED_STATE
        : ({ ...EMPTY_OAUTH_FLOW_STATE } as OAuthFlowState);

    it("renders the same diagram actions", () => {
      expect(
        buildOAuthSequenceActions({
          protocolVersion,
          registrationStrategy: registrationStrategy as never,
          flowState,
        }),
      ).toMatchSnapshot();
    });

    // Structural invariants that survive any refactor of the builders: the
    // diagram is a list of uniquely-identified steps between known actors.
    it("emits unique step ids between known actors", () => {
      const actions = buildOAuthSequenceActions({
        protocolVersion,
        registrationStrategy: registrationStrategy as never,
        flowState,
      });

      expect(actions.length).toBeGreaterThan(0);
      const ids = actions.map((action) => action.id);
      expect(new Set(ids).size).toBe(ids.length);

      const actors = new Set(["client", "browser", "authServer", "mcpServer"]);
      for (const action of actions) {
        expect(actors.has(action.from), `from: ${action.from}`).toBe(true);
        expect(actors.has(action.to), `to: ${action.to}`).toBe(true);
        expect(action.label.length).toBeGreaterThan(0);
      }
    });
  },
);
