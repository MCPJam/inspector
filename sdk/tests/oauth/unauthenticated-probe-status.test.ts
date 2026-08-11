import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";
import {
  classifyUnauthenticatedProbe,
  hasBearerChallenge,
  parseInsufficientScopeChallenge,
} from "../../src/oauth/state-machines/shared/challenges.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";

/** Every protocol machine implements the same probe step. */
const PROTOCOL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

/** The step a machine advances to once it accepts the challenge. */
function challengedStep(protocolVersion: OAuthProtocolVersion): string {
  // 2025-03-26 predates RFC 9728 resource metadata, so it goes straight to
  // discovery instead of parking on the challenge.
  return protocolVersion === "2025-03-26"
    ? "discovery_start"
    : "received_401_unauthorized";
}

function driveProbe(
  protocolVersion: OAuthProtocolVersion,
  response: {
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
) {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    currentStep: "request_without_token",
    serverUrl: SERVER_URL,
    httpHistory: [
      {
        step: "request_without_token",
        timestamp: Date.now(),
        request: {
          method: "POST",
          url: SERVER_URL,
          headers: {},
          body: { method: "initialize" },
        },
      },
    ],
    infoLogs: [],
  };

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
    requestExecutor: jest.fn().mockResolvedValue({
      ok: response.status < 400,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers ?? {},
      body: response.body ?? {},
    }),
    dynamicRegistration: { client_name: "Test Client" },
  });

  return {
    run: async () => {
      await machine.proceedToNextStep();
      return state;
    },
  };
}

describe("classifyUnauthenticatedProbe", () => {
  it("treats 401 as the spec-compliant challenge", () => {
    expect(
      classifyUnauthenticatedProbe({ status: 401, statusText: "Unauthorized" })
    ).toEqual({ kind: "challenged", specCompliant: true });
  });

  it("treats 200 as anonymous access", () => {
    expect(
      classifyUnauthenticatedProbe({ status: 200, statusText: "OK" })
    ).toEqual({ kind: "anonymous_allowed" });
  });

  it("accepts a 403 that carries a Bearer challenge, flagged non-compliant", () => {
    expect(
      classifyUnauthenticatedProbe({
        status: 403,
        statusText: "Forbidden",
        wwwAuthenticateHeader:
          'Bearer error="insufficient_scope", scope="mcp:read mcp:write"',
      })
    ).toEqual({ kind: "challenged", specCompliant: false });
  });

  it("accepts a 403 whose Bearer challenge carries no auth-params", () => {
    expect(
      classifyUnauthenticatedProbe({
        status: 403,
        statusText: "Forbidden",
        wwwAuthenticateHeader: "Bearer",
      })
    ).toEqual({ kind: "challenged", specCompliant: false });
  });

  it("rejects a bare 403 and points at an upstream block", () => {
    const outcome = classifyUnauthenticatedProbe({
      status: 403,
      statusText: "Forbidden",
    });

    expect(outcome.kind).toBe("unexpected");
    if (outcome.kind !== "unexpected") throw new Error("expected unexpected");
    expect(outcome.message).toContain("403 Forbidden");
    expect(outcome.message).toContain("no WWW-Authenticate challenge");
    expect(outcome.message).toMatch(/WAF|proxy/);
  });

  it("does not mistake a non-Bearer challenge on a 403 for an auth challenge", () => {
    expect(
      classifyUnauthenticatedProbe({
        status: 403,
        statusText: "Forbidden",
        wwwAuthenticateHeader: 'Basic realm="admin"',
      }).kind
    ).toBe("unexpected");
  });

  it("reports other statuses against what MCP requires", () => {
    const outcome = classifyUnauthenticatedProbe({
      status: 500,
      statusText: "Internal Server Error",
      serverMessage: "boom",
    });

    expect(outcome.kind).toBe("unexpected");
    if (outcome.kind !== "unexpected") throw new Error("expected unexpected");
    expect(outcome.message).toContain("HTTP 500 boom");
    expect(outcome.message).toContain("401 Unauthorized");
  });

  it("never labels a status mismatch as a failure to reach the server", () => {
    for (const status of [403, 418, 500]) {
      const outcome = classifyUnauthenticatedProbe({
        status,
        statusText: "Nope",
      });
      if (outcome.kind !== "unexpected") throw new Error("expected unexpected");
      expect(outcome.message).not.toContain("Failed to request MCP server");
    }
  });
});

describe("hasBearerChallenge", () => {
  it.each([
    ["Bearer", true],
    ['Bearer realm="mcp"', true],
    ['Basic realm="x", Bearer error="insufficient_scope"', true],
    ['Basic realm="x"', false],
    ['Basic realm="contains the word Bearer inside a quote"', false],
    ["", false],
    [undefined, false],
  ])("%s -> %s", (header, expected) => {
    expect(hasBearerChallenge(header as string | undefined)).toBe(expected);
  });

  it("sees a Bearer challenge that follows a param-less scheme", () => {
    expect(hasBearerChallenge('Basic, Bearer realm="mcp"')).toBe(true);
  });
});

describe("param-less challenge grouping", () => {
  // A segment that is nothing but a scheme token opens a new challenge
  // (RFC 7235 §4.1) rather than folding into the previous challenge's
  // auth-params. Pinned because the tolerant reading silently attributed a
  // later scheme's params to Bearer.
  it("does not attribute a following scheme's params to Bearer", () => {
    expect(
      parseInsufficientScopeChallenge(
        'Bearer realm="x", scope, error="insufficient_scope"'
      ).isInsufficientScope
    ).toBe(false);
  });

  it("still reads insufficient_scope from a well-formed Bearer challenge", () => {
    expect(
      parseInsufficientScopeChallenge(
        'Bearer realm="x", error="insufficient_scope", scope="mcp:read"'
      )
    ).toMatchObject({
      isInsufficientScope: true,
      challengedScopes: ["mcp:read"],
    });
  });

  it("keeps a param-less Bearer free of fabricated params", () => {
    expect(parseInsufficientScopeChallenge("Bearer")).toEqual({
      isInsufficientScope: false,
      challengedScopes: undefined,
      resourceMetadata: undefined,
    });
  });

  // `auth-scheme` is a bare token, so a scheme may open with a digit or
  // punctuation. A leading-letter rule sent these segments to the auth-param
  // branch, crediting the following scheme's parameters to Bearer.
  it.each(["1Other", "9", "!weird", "-dash"])(
    "opens a challenge on the %s scheme instead of crediting Bearer",
    (scheme) => {
      expect(
        parseInsufficientScopeChallenge(
          `Bearer realm="x", ${scheme} error="insufficient_scope"`
        )
      ).toMatchObject({
        isInsufficientScope: false,
        challengedScopes: undefined,
      });
    }
  );

  it("reads a digit-initial scheme's own Bearer sibling correctly", () => {
    expect(
      parseInsufficientScopeChallenge(
        '1Other realm="x", Bearer error="insufficient_scope", scope="mcp:read"'
      )
    ).toMatchObject({
      isInsufficientScope: true,
      challengedScopes: ["mcp:read"],
    });
  });

  it("sees a Bearer challenge after a digit-initial scheme", () => {
    expect(hasBearerChallenge('1Other realm="x", Bearer realm="mcp"')).toBe(
      true
    );
  });
});

describe.each(PROTOCOL_VERSIONS)(
  "%s unauthenticated probe",
  (protocolVersion) => {
    it("continues discovery from a 403 that carries a Bearer challenge", async () => {
      const state = await driveProbe(protocolVersion, {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
        },
      }).run();

      expect(state.error).toBeUndefined();
      expect(state.currentStep).toBe(challengedStep(protocolVersion));

      const warning = (state.infoLogs ?? []).find(
        (log) => log.id === "non-compliant-challenge-status"
      );
      expect(warning).toBeDefined();
      expect(warning?.level).toBe("warning");
      expect(warning?.data).toMatchObject({
        Received: "403 Forbidden",
        Expected: "401 Unauthorized",
      });
    });

    it("fails a bare 403 without relabelling it as a request failure", async () => {
      const state = await driveProbe(protocolVersion, {
        status: 403,
        statusText: "Forbidden",
      }).run();

      expect(state.error).toBeDefined();
      expect(state.error).not.toContain("Failed to request MCP server");
      expect(state.error).toContain("403 Forbidden");
      expect(state.error).toContain("no WWW-Authenticate challenge");
      expect(state.isInitiatingAuth).toBe(false);
    });

    it("still reports a transport failure as a failure to reach the server", async () => {
      let state: OAuthFlowState = {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "request_without_token",
        serverUrl: SERVER_URL,
        httpHistory: [],
        infoLogs: [],
      };

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
        requestExecutor: jest
          .fn()
          .mockRejectedValue(new Error("socket hang up")),
        dynamicRegistration: { client_name: "Test Client" },
      });

      await machine.proceedToNextStep();

      expect(state.error).toContain("Failed to request MCP server");
      expect(state.error).toContain("socket hang up");
    });
  }
);
