/**
 * INSPECTOR-CLIENT-2EQ: when every authorization-server well-known URL
 * answered with a 4xx, the machines reported
 * `Could not discover authorization server metadata. Last error: null` — the
 * "last error" was only ever set for a 5xx or a transport failure. The message
 * now names every URL tried and what each returned.
 */

import { describeAuthorizationServerDiscoveryFailure } from "../../src/oauth/state-machines/shared/authorization-server-discovery.js";
import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type {
  OAuthFlowState,
  OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";

const SERVER_URL = "https://mcp.example.com/mcp";
// With a path, so every era tries more than one well-known URL (2025-06-18
// tries only one for a root issuer).
const AUTH_SERVER_URL = "https://auth.example.com/tenant";

/** 2025-03-26 falls back to default endpoints instead of failing. */
const DISCOVERY_ERAS: OAuthProtocolVersion[] = [
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

describe("describeAuthorizationServerDiscoveryFailure", () => {
  it("names every URL and what it returned", () => {
    expect(
      describeAuthorizationServerDiscoveryFailure([
        {
          url: "https://a.test/.well-known/oauth-authorization-server",
          status: 404,
        },
        { url: "https://a.test/.well-known/openid-configuration", status: 503 },
        {
          url: "https://a.test/.well-known/openid-configuration/x",
          error: new TypeError("Failed to fetch"),
        },
      ])
    ).toBe(
      "Could not discover authorization server metadata. " +
        "https://a.test/.well-known/oauth-authorization-server returned HTTP 404; " +
        "https://a.test/.well-known/openid-configuration returned HTTP 503; " +
        "https://a.test/.well-known/openid-configuration/x failed: Failed to fetch."
    );
  });

  it("says when a success carried no document", () => {
    expect(
      describeAuthorizationServerDiscoveryFailure([
        {
          url: "https://a.test/.well-known/oauth-authorization-server",
          status: 200,
        },
      ])
    ).toBe(
      "Could not discover authorization server metadata. " +
        "https://a.test/.well-known/oauth-authorization-server returned HTTP 200 with no metadata document."
    );
  });

  it("stringifies whatever else was thrown", () => {
    expect(
      describeAuthorizationServerDiscoveryFailure([
        { url: "https://a.test/x", error: "boom" },
      ])
    ).toBe(
      "Could not discover authorization server metadata. https://a.test/x failed: boom."
    );
  });

  it("says when no URL was tried", () => {
    expect(describeAuthorizationServerDiscoveryFailure([])).toBe(
      "Could not discover authorization server metadata. No well-known URL was tried."
    );
  });
});

function makeMachineAtAsMetadata(
  protocolVersion: OAuthProtocolVersion,
  respond: (url: string) => unknown
) {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    serverUrl: SERVER_URL,
    currentStep: "request_authorization_server_metadata",
    authorizationServerUrl: AUTH_SERVER_URL,
    resourceMetadata: {
      resource: SERVER_URL,
      authorization_servers: [AUTH_SERVER_URL],
    },
  } as OAuthFlowState;

  const requestExecutor = vi.fn(async ({ url }: { url: string }) =>
    respond(url)
  );

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
    redirectUrl: "http://127.0.0.1:3333/callback",
    requestExecutor: requestExecutor as never,
    dynamicRegistration: { client_name: "Test Client" },
  });

  return { machine, getState: () => state, requestExecutor };
}

describe.each(DISCOVERY_ERAS)(
  "authorization-server discovery failure (%s)",
  (version) => {
    // `proceedToNextStep` catches step errors into state, so anything that
    // escapes it is a real failure and should fail the test.
    const advance = (machine: { proceedToNextStep: () => Promise<void> }) =>
      machine.proceedToNextStep();

    it("reports each URL's status when every one answers 404", async () => {
      const { machine, getState, requestExecutor } = makeMachineAtAsMetadata(
        version,
        () => ({
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: {},
          body: "",
        })
      );
      await advance(machine);

      const error = getState().error ?? "";
      expect(error).not.toContain("null");
      expect(error).toMatch(
        /^Could not discover authorization server metadata\. /
      );
      const urls = requestExecutor.mock.calls.map(([request]) => request.url);
      expect(urls.length).toBeGreaterThan(1);
      for (const url of urls) {
        expect(error).toContain(`${url} returned HTTP 404`);
      }
    });

    // Review of #5532: the helper's 2xx wording was tested, but not the machines
    // recording that attempt. Without the record this reads "No well-known URL
    // was tried."
    it("reports a success that carried no document", async () => {
      const { machine, getState } = makeMachineAtAsMetadata(version, () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: "",
      }));
      await advance(machine);

      expect(getState().error).toContain(
        "returned HTTP 200 with no metadata document"
      );
    });

    it("keeps a transport failure and a later 404 both visible", async () => {
      let call = 0;
      const { machine, getState } = makeMachineAtAsMetadata(version, () => {
        call += 1;
        if (call === 1) throw new TypeError("Failed to fetch");
        return {
          ok: false,
          status: 404,
          statusText: "Not Found",
          headers: {},
          body: "",
        };
      });
      await advance(machine);

      const error = getState().error ?? "";
      expect(error).toContain("failed: Failed to fetch");
      expect(error).toContain("returned HTTP 404");
    });
  }
);
