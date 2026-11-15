/**
 * INSPECTOR-CLIENT-2EQ: when every authorization-server well-known URL
 * answered with a 4xx, the machines reported
 * `Could not discover authorization server metadata. Last error: null` — the
 * "last error" was only ever set for a 5xx or a transport failure. The message
 * now names every URL tried and what each returned.
 */

import {
  classifyAuthorizationServerMetadataResponse,
  describeAuthorizationServerDiscoveryFailure,
} from "../../src/oauth/state-machines/shared/authorization-server-discovery.js";
import { OAuthOutboundUrlBlockedError } from "../../src/oauth/ssrf-guard.js";
import {
  createOAuthStateMachine,
  OAuthRedactedCredentialError,
} from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type {
  OAuthFlowState,
  OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";

const SERVER_URL = "https://mcp.example.com/mcp";
// With a path, so every era tries more than one well-known URL (2025-06-18
// tries only one for a root issuer).
const AUTH_SERVER_URL = "https://auth.example.com/tenant";

const VALID_METADATA = {
  issuer: AUTH_SERVER_URL,
  authorization_endpoint: `${AUTH_SERVER_URL}/authorize`,
  token_endpoint: `${AUTH_SERVER_URL}/token`,
  registration_endpoint: `${AUTH_SERVER_URL}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

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

  it("names a redirect it did not follow", () => {
    expect(
      describeAuthorizationServerDiscoveryFailure([
        {
          url: "https://a.test/.well-known/oauth-authorization-server",
          status: 302,
          location: "https://login.a.test/",
        },
      ])
    ).toBe(
      "Could not discover authorization server metadata. " +
        "https://a.test/.well-known/oauth-authorization-server returned HTTP 302 " +
        "redirecting to https://login.a.test/, which discovery does not follow."
    );
  });

  it("names the type of a success that was not JSON", () => {
    expect(
      describeAuthorizationServerDiscoveryFailure([
        {
          url: "https://a.test/x",
          status: 200,
          notJson: { contentType: "text/html" },
        },
        { url: "https://a.test/y", status: 200, notJson: {} },
      ])
    ).toBe(
      "Could not discover authorization server metadata. " +
        "https://a.test/x returned HTTP 200 with text/html that is not a JSON metadata document; " +
        "https://a.test/y returned HTTP 200 with a body that is not a JSON metadata document."
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

describe("classifyAuthorizationServerMetadataResponse", () => {
  const url = "https://a.test/.well-known/oauth-authorization-server";

  it("takes a non-empty JSON object as the document", () => {
    const body = { issuer: "https://a.test" };
    expect(
      classifyAuthorizationServerMetadataResponse(url, {
        status: 200,
        headers: {},
        body,
      })
    ).toEqual({ kind: "document", document: body });
  });

  it.each([null, undefined, "", "  ", {}])(
    "records an empty 2xx (%j) as no document",
    (body) => {
      expect(
        classifyAuthorizationServerMetadataResponse(url, {
          status: 200,
          headers: {},
          body,
        })
      ).toEqual({ kind: "attempt", attempt: { url, status: 200 } });
    }
  );

  it("records an HTML 200 with its declared type", () => {
    expect(
      classifyAuthorizationServerMetadataResponse(url, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: "<!doctype html><title>Sign in</title>",
      })
    ).toEqual({
      kind: "attempt",
      attempt: { url, status: 200, notJson: { contentType: "text/html" } },
    });
  });

  it("does not take a JSON array as the document", () => {
    expect(
      classifyAuthorizationServerMetadataResponse(url, {
        status: 200,
        headers: {},
        body: [],
      })
    ).toEqual({ kind: "attempt", attempt: { url, status: 200, notJson: {} } });
  });

  it("keeps a 3xx's Location, whatever the header's case", () => {
    expect(
      classifyAuthorizationServerMetadataResponse(url, {
        status: 307,
        headers: { Location: "https://b.test/meta" },
        body: null,
      })
    ).toEqual({
      kind: "attempt",
      attempt: { url, status: 307, location: "https://b.test/meta" },
    });
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

    it("moves past an HTML 200 to a later URL's document", async () => {
      // An SPA host answers every path with its login page.
      let call = 0;
      const { machine, getState, requestExecutor } = makeMachineAtAsMetadata(
        version,
        () => {
          call += 1;
          return call === 1
            ? {
                ok: true,
                status: 200,
                statusText: "OK",
                headers: { "content-type": "text/html" },
                body: "<!doctype html><title>Sign in</title>",
              }
            : {
                ok: true,
                status: 200,
                statusText: "OK",
                headers: { "content-type": "application/json" },
                body: VALID_METADATA,
              };
        }
      );
      await advance(machine);

      expect(requestExecutor).toHaveBeenCalledTimes(2);
      expect(getState().currentStep).toBe(
        "received_authorization_server_metadata"
      );
      expect(getState().authorizationServerMetadata).toMatchObject({
        issuer: AUTH_SERVER_URL,
      });
    });

    it("tries the next URL past an empty 2xx and names an HTML one", async () => {
      let call = 0;
      const { machine, getState, requestExecutor } = makeMachineAtAsMetadata(
        version,
        () => {
          call += 1;
          return call === 1
            ? {
                ok: true,
                status: 204,
                statusText: "No Content",
                headers: {},
                body: null,
              }
            : {
                ok: true,
                status: 200,
                statusText: "OK",
                headers: { "content-type": "text/html" },
                body: "<html></html>",
              };
        }
      );
      await advance(machine);

      const error = getState().error ?? "";
      const urls = requestExecutor.mock.calls.map(([request]) => request.url);
      expect(urls.length).toBeGreaterThan(1);
      expect(error).toContain(
        `${urls[0]} returned HTTP 204 with no metadata document`
      );
      expect(error).toContain(
        `${urls[1]} returned HTTP 200 with text/html that is not a JSON metadata document`
      );
    });

    it("names where a redirect pointed", async () => {
      const { machine, getState } = makeMachineAtAsMetadata(version, () => ({
        ok: false,
        status: 302,
        statusText: "Found",
        headers: { location: "https://login.example.com/" },
        body: "",
      }));
      await advance(machine);

      expect(getState().error).toContain(
        "returned HTTP 302 redirecting to https://login.example.com/, which discovery does not follow"
      );
    });

    it.each([
      [
        "SSRF guard",
        () =>
          new OAuthOutboundUrlBlockedError(
            AUTH_SERVER_URL,
            "private-host",
            "Refusing to send an OAuth request to a private address"
          ),
      ],
      [
        "redaction guard",
        () => new OAuthRedactedCredentialError("access_token", AUTH_SERVER_URL),
      ],
    ])("surfaces the %s refusal as itself", async (_name, makeError) => {
      const guardError = makeError();
      const { machine, getState, requestExecutor } = makeMachineAtAsMetadata(
        version,
        () => {
          throw guardError;
        }
      );
      await advance(machine);

      const error = getState().error ?? "";
      expect(error).toContain(guardError.message);
      expect(error).not.toMatch(/^Could not discover/);
      expect(requestExecutor).toHaveBeenCalledTimes(1);
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
