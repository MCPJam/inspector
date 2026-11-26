/**
 * Client OAuth rules MCPJam follows while it runs an authorization flow.
 *
 * The flow is a state machine per protocol revision, driven by the OAuth
 * conformance runner (whose steps are the checks the rules page maps:
 * received_authorization_code, request_authorization_server_metadata,
 * received_resource_metadata, cimd_metadata_response). The machines run here
 * with a scripted request executor, so no socket is needed.
 *
 * Where an existing test already proves a rule exactly, and nothing more, it
 * is pointed to with `coveredBy`; the new tests fill the paths nothing proved
 * yet.
 */

import { describe, expect, vi } from "vitest";
import { completeHeadlessAuthorization } from "../../src/oauth-conformance/auth-strategies/headless.js";
import { createInteractiveAuthorizationSession } from "../../src/oauth-conformance/auth-strategies/interactive.js";
import { startAuthorization } from "../../src/oauth/browser-auth.js";
import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";
import { coveredBy, ruleTest } from "./harness.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";
const AUTHORIZE_URL = "https://auth.example.com/authorize?state=sent-state";

function redirectingTo(location: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 302,
    statusText: "Found",
    headers: { location },
    body: undefined,
  });
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body,
  };
}

describe("C196: the callback state must match", () => {
  coveredBy(
    "C196",
    "tests/oauth-conformance/remote-browser.test.ts",
    "rejects authorize with a state mismatch when state is wrong",
  );
  coveredBy(
    "C196",
    "tests/oauth-conformance/remote-browser.test.ts",
    "rejects authorize when state is missing but one was expected",
  );

  ruleTest("C196", "the interactive strategy rejects a callback with a different state", async () => {
    const session = await createInteractiveAuthorizationSession();
    try {
      const result = session.authorize({
        authorizationUrl: "https://auth.example.com/authorize",
        expectedState: "sent-state",
        timeoutMs: 10_000,
        openUrl: async () => {
          await fetch(`${session.redirectUrl}?code=c&state=other-state`).catch(() => {});
        },
      });
      await expect(result).rejects.toThrow(/state/i);
    } finally {
      await session.stop().catch(() => undefined);
    }
  });

  ruleTest("C196", "the headless strategy rejects a callback with a different state", async () => {
    await expect(
      completeHeadlessAuthorization({
        authorizationUrl: AUTHORIZE_URL,
        redirectUrl: REDIRECT_URI,
        expectedState: "sent-state",
        request: redirectingTo(`${REDIRECT_URI}?code=c&state=other-state`),
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  ruleTest("C196", "the headless strategy rejects a callback with no state", async () => {
    await expect(
      completeHeadlessAuthorization({
        authorizationUrl: AUTHORIZE_URL,
        redirectUrl: REDIRECT_URI,
        expectedState: "sent-state",
        request: redirectingTo(`${REDIRECT_URI}?code=c`),
      }),
    ).rejects.toThrow(/state mismatch.*missing/i);
  });

  ruleTest("C196", "(control) the headless strategy accepts the state it sent", async () => {
    await expect(
      completeHeadlessAuthorization({
        authorizationUrl: AUTHORIZE_URL,
        redirectUrl: REDIRECT_URI,
        expectedState: "sent-state",
        request: redirectingTo(`${REDIRECT_URI}?code=c&state=sent-state`),
      }),
    ).resolves.toEqual({ code: "c" });
  });
});

describe("C197: no authorization without code_challenge_methods_supported", () => {
  coveredBy(
    "C197",
    "tests/oauth/era-differential-goldens.test.ts",
    "stops before authorization when the AS advertises no PKCE metadata",
  );

  const metadata = {
    issuer: "https://auth.example.com",
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    response_types_supported: ["code"],
  };

  ruleTest.knownBreak(
    "C197",
    "the exported startAuthorization builds an authorization URL when code_challenge_methods_supported is absent",
    "src/oauth/browser-auth.ts:1058-1068 only refuses a list that lacks S256, and goes on when the field is absent; the per-revision state machines refuse correctly",
    async () => {
      const { authorizationUrl } = await startAuthorization("https://auth.example.com", {
        metadata: metadata as never,
        clientInformation: { client_id: "client" },
        redirectUrl: REDIRECT_URI,
        state: "s",
      });
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
        "https://auth.example.com/authorize",
      );
      expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    },
  );

  ruleTest(
    "C197",
    "(control) the exported startAuthorization refuses a list without S256",
    async () => {
      await expect(
        startAuthorization("https://auth.example.com", {
          metadata: { ...metadata, code_challenge_methods_supported: ["plain"] } as never,
          clientInformation: { client_id: "client" },
          redirectUrl: REDIRECT_URI,
          state: "s",
        }),
      ).rejects.toThrow(/code challenge method/);
    },
  );
});

describe("C198: protected resource metadata with a bad resource is refused", () => {
  coveredBy(
    "C198",
    "tests/oauth/state-machine-regressions.test.ts",
    "fails discovery under reject enforcement when PRM omits its resource in %s",
  );
  coveredBy(
    "C198",
    "tests/oauth/state-machine-regressions.test.ts",
    "fails the discovery step on an unusable PRM resource under reject enforcement in %s",
  );

  async function runResourceMetadataStep(
    resource: string | undefined,
    enforcement: "reject" | "reject-rfc9728",
  ): Promise<OAuthFlowState> {
    let state: OAuthFlowState = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_resource_metadata",
      serverUrl: SERVER_URL,
      httpHistory: [],
      infoLogs: [],
    };
    const machine = createOAuthStateMachine({
      protocolVersion: "2026-07-28",
      registrationStrategy: "preregistered" as never,
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: vi.fn().mockResolvedValue(
        jsonResponse({
          ...(resource !== undefined ? { resource } : {}),
          authorization_servers: ["https://auth.example.com"],
        }),
      ),
      resourceIndicatorEnforcement: enforcement,
    });
    await machine.proceedToNextStep();
    return state;
  }

  for (const enforcement of ["reject", "reject-rfc9728"] as const) {
    ruleTest(
      "C198",
      `2026-07-28 under "${enforcement}": metadata without its resource fails discovery`,
      async () => {
        const state = await runResourceMetadataStep(undefined, enforcement);
        expect(state.error).toMatch(/missing its required "resource"/);
        expect(state.currentStep).not.toBe("received_resource_metadata");
      },
    );

    ruleTest(
      "C198",
      `2026-07-28 under "${enforcement}": a resource on another origin fails discovery`,
      async () => {
        const state = await runResourceMetadataStep("https://evil.example.com/mcp", enforcement);
        expect(state.error).toBeTruthy();
        expect(state.currentStep).not.toBe("received_resource_metadata");
        expect(state.resourceIndicator).toBeUndefined();
      },
    );
  }

  // A resource on this server's origin but not the URL being accessed fails
  // RFC 9728 §3.3 ("MUST NOT be used" unless identical).
  const SAME_ORIGIN_OTHER_PATH = "https://mcp.example.com/v2/other";

  ruleTest(
    "C198",
    '2026-07-28 under "reject-rfc9728" (the conformance runner): a same-origin resource for another path fails discovery',
    async () => {
      const state = await runResourceMetadataStep(SAME_ORIGIN_OTHER_PATH, "reject-rfc9728");
      expect(state.error).toBeTruthy();
      expect(state.currentStep).not.toBe("received_resource_metadata");
    },
  );

  ruleTest.knownBreak(
    "C198",
    '2026-07-28 under "reject" (the login path): a same-origin resource for another path is accepted',
    'src/oauth-login.ts:541 runs the flow with "reject", which refuses only an unusable resource (src/oauth/state-machines/shared/resource-indicator.ts:86-91) and lets a same-origin mismatch through with a warning, on purpose for servers like Asana (tests/oauth/state-machine-regressions.test.ts)',
    async () => {
      const state = await runResourceMetadataStep(SAME_ORIGIN_OTHER_PATH, "reject");
      expect(state.error).toBeUndefined();
      expect(state.currentStep).toBe("received_resource_metadata");
      expect(state.resourceIndicator?.rfc9728Compliant).toBe(false);
    },
  );

  // Not covered on purpose: the OAuth debugger's default "warn" enforcement.
  // It is a diagnostic tool that shows the warning and carries on so the rest
  // of the flow can be inspected, not a client that relies on the metadata.

  ruleTest("C198", "(control) 2026-07-28 accepts metadata naming this server", async () => {
    const state = await runResourceMetadataStep(SERVER_URL, "reject-rfc9728");
    expect(state.error).toBeUndefined();
    expect(state.currentStep).toBe("received_resource_metadata");
    expect(state.resourceIndicator?.value).toBe(SERVER_URL);
  });
});

describe("C199: a CIMD document's client_id is exactly its URL", () => {
  const CIMD_URL = "https://client.example.com/.well-known/client-metadata.json";

  async function validateCimdDocument(
    version: OAuthProtocolVersion,
    clientId: string,
  ): Promise<OAuthFlowState> {
    let state: OAuthFlowState = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "cimd_fetch_request",
      serverUrl: SERVER_URL,
    };
    const machine = createOAuthStateMachine({
      protocolVersion: version,
      registrationStrategy: "cimd",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: vi.fn().mockResolvedValue(
        jsonResponse({
          client_id: clientId,
          client_name: "Client",
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
        }),
      ),
      clientIdMetadataUrl: CIMD_URL,
      dynamicRegistration: { client_name: "Client" },
    });
    await machine.proceedToNextStep(); // fetch the document
    await machine.proceedToNextStep(); // validate it
    return state;
  }

  for (const version of ["2025-11-25", "2026-07-28"] as OAuthProtocolVersion[]) {
    for (const [what, clientId] of [
      ["another URL", "https://other.example.com/.well-known/client-metadata.json"],
      ["the URL with a trailing slash", `${CIMD_URL}/`],
      ["the URL in a different case", CIMD_URL.replace("client.example", "Client.Example")],
    ] as const) {
      ruleTest("C199", `${version}: a document whose client_id is ${what} is refused`, async () => {
        const state = await validateCimdDocument(version, clientId);
        expect(state.error).toMatch(/CIMD client_id mismatch/);
        expect(state.currentStep).not.toBe("received_client_credentials");
        expect(state.clientId).not.toBe(clientId);
      });
    }

    ruleTest("C199", `(control) ${version}: a document whose client_id is its URL is accepted`, async () => {
      const state = await validateCimdDocument(version, CIMD_URL);
      expect(state.error).toBeUndefined();
      expect(state.currentStep).toBe("received_client_credentials");
      expect(state.clientId).toBe(CIMD_URL);
    });
  }
});
