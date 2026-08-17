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

// 2025-03-26 intentionally has no resource-metadata details in this action,
// so it never parses the displayed URL and cannot hit this rendering crash.
// Derived from ALL_VERSIONS rather than listed, so a new era is covered the
// moment it is added rather than silently skipping this regression.
describe.each(ALL_VERSIONS.filter((version) => version !== "2025-03-26"))(
  "sequence actions (%s / invalid resource metadata URL)",
  (protocolVersion) => {
    it.each<[unknown, string]>([
      [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource (not an absolute URL)",
      ],
      ["", '"" (not an absolute URL)'],
      [null, "null (not an absolute URL)"],
      [
        { href: "/.well-known/oauth-protected-resource" },
        '{"href":"/.well-known/oauth-protected-resource"} (not an absolute URL)',
      ],
    ])("annotates malformed value %j without crashing", (value, displayed) => {
      let actions: ReturnType<typeof buildOAuthSequenceActions> = [];
      expect(() => {
        actions = buildOAuthSequenceActions({
          protocolVersion,
          registrationStrategy: "dcr",
          flowState: {
            ...EMPTY_OAUTH_FLOW_STATE,
            resourceMetadataUrl: value,
          } as OAuthFlowState,
        });
      }).not.toThrow();

      expect(
        actions.find((action) => action.id === "request_resource_metadata")
          ?.details
      ).toEqual([{ label: "GET", value: displayed }]);
    });
  }
);

// The authorization-server metadata step renders on EVERY era, including
// 2025-03-26 — it is outside the protected-resource preamble — so its
// endpoints have a wider blast radius than the resource-metadata URL above.
// RFC 8414 requires absolute endpoints, but the machines validate only that
// the fields are present, so a relative one reaches the diagram unchecked.
describe.each(ALL_VERSIONS)(
  "sequence actions (%s / relative authorization server endpoints)",
  (protocolVersion) => {
    it.each<[unknown, unknown, string, string]>([
      [
        "/token",
        "/authorize",
        "/token (not an absolute URL)",
        "/authorize (not an absolute URL)",
      ],
      [
        "",
        "/authorize",
        '"" (not an absolute URL)',
        "/authorize (not an absolute URL)",
      ],
      [
        null,
        "/authorize",
        "null (not an absolute URL)",
        "/authorize (not an absolute URL)",
      ],
      [
        "/token",
        "",
        "/token (not an absolute URL)",
        '"" (not an absolute URL)',
      ],
      [
        "/token",
        null,
        "/token (not an absolute URL)",
        "null (not an absolute URL)",
      ],
      [
        { href: "/token" },
        ["/authorize"],
        '{"href":"/token"} (not an absolute URL)',
        '["/authorize"] (not an absolute URL)',
      ],
    ])(
      "annotates malformed token %j and authorization %j without crashing",
      (tokenEndpoint, authorizationEndpoint, displayedToken, displayedAuth) => {
        let actions: ReturnType<typeof buildOAuthSequenceActions> = [];
        expect(() => {
          actions = buildOAuthSequenceActions({
            protocolVersion,
            registrationStrategy: "dcr",
            flowState: {
              ...EMPTY_OAUTH_FLOW_STATE,
              authorizationServerMetadata: {
                issuer: "https://auth-server.example.com",
                authorization_endpoint: authorizationEndpoint,
                token_endpoint: tokenEndpoint,
                response_types_supported: ["code"],
              },
            } as OAuthFlowState,
          });
        }).not.toThrow();

        expect(
          actions.find(
            (action) => action.id === "received_authorization_server_metadata"
          )?.details
        ).toEqual([
          { label: "Token", value: displayedToken },
          { label: "Auth", value: displayedAuth },
        ]);
      }
    );
  }
);
