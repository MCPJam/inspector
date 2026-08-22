import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";
import {
  classifyUnauthenticatedProbe,
  hasBearerChallenge,
  isUnauthenticatedProbeChallenge,
  parseBearerAuthenticateParameters,
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

  it("blames the missing Bearer challenge, not a header that did arrive", () => {
    const outcome = classifyUnauthenticatedProbe({
      status: 403,
      statusText: "Forbidden",
      wwwAuthenticateHeader: 'Basic realm="admin"',
    });

    if (outcome.kind !== "unexpected") throw new Error("expected unexpected");
    expect(outcome.message).toContain("no Bearer challenge");
    expect(outcome.message).not.toContain("no WWW-Authenticate challenge");
  });

  // A quoted-pair must not end the quoted string early, or one scheme's realm
  // parses as further challenges and fabricates a Bearer the server never sent.
  it("refuses a 403 whose Bearer challenge is forged inside a quoted realm", () => {
    const forged = 'Basic realm="a\\", Bearer error=\\"insufficient_scope\\""';

    expect(hasBearerChallenge(forged)).toBe(false);
    expect(
      classifyUnauthenticatedProbe({
        status: 403,
        statusText: "Forbidden",
        wwwAuthenticateHeader: forged,
      }).kind
    ).toBe("unexpected");
  });

  it("still accepts a real Bearer challenge alongside an escaped quote", () => {
    const header = 'Basic realm="say \\"hi\\"", Bearer scope="mcp:read"';

    expect(hasBearerChallenge(header)).toBe(true);
    expect(
      classifyUnauthenticatedProbe({
        status: 403,
        statusText: "Forbidden",
        wwwAuthenticateHeader: header,
      })
    ).toEqual({ kind: "challenged", specCompliant: false });
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

// The surface that renders the flow decides "was this exchange expected?" from
// this predicate, so it has to admit exactly what the flow advances on. A
// mismatch paints an accepted 403 red next to the warning explaining it.
describe("isUnauthenticatedProbeChallenge", () => {
  const probe = (
    over: Partial<Parameters<typeof isUnauthenticatedProbeChallenge>[0]> = {}
  ) =>
    isUnauthenticatedProbeChallenge({
      step: "request_without_token",
      status: 401,
      statusText: "Unauthorized",
      ...over,
    });

  it("admits the spec-compliant 401", () => {
    expect(probe()).toBe(true);
  });

  it("admits a 403 that carries a Bearer challenge", () => {
    expect(
      probe({
        status: 403,
        statusText: "Forbidden",
        wwwAuthenticateHeader: 'Bearer scope="mcp:read"',
      })
    ).toBe(true);
  });

  it("rejects a bare 403", () => {
    expect(probe({ status: 403, statusText: "Forbidden" })).toBe(false);
  });

  it("rejects a challenge on any other step", () => {
    expect(probe({ step: "authenticated_mcp_request" })).toBe(false);
  });

  it("rejects an exchange with no response yet", () => {
    expect(probe({ status: undefined })).toBe(false);
  });

  // 200 means the server served the request; it is not an error either, but it
  // is not a challenge, and callers already treat sub-400 as success.
  it("rejects anonymous access", () => {
    expect(probe({ status: 200, statusText: "OK" })).toBe(false);
  });

  it("agrees with the flow gate on every status it admits", () => {
    for (const [status, header] of [
      [401, undefined],
      [403, 'Bearer resource_metadata="https://mcp.example.com/prm"'],
      [403, undefined],
      [500, undefined],
    ] as Array<[number, string | undefined]>) {
      const admitted = probe({ status, wwwAuthenticateHeader: header });
      const gate = classifyUnauthenticatedProbe({
        status,
        wwwAuthenticateHeader: header,
      });
      expect(admitted).toBe(gate.kind === "challenged");
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

describe("parseBearerAuthenticateParameters", () => {
  const PRM =
    "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

  // The acceptance gate reads the whole challenge list, so the parameter reader
  // has to as well. Anchoring on a leading `Bearer` returned nothing for a
  // header that led with another scheme, and discovery then derived a PRM URL
  // instead of using the advertised one.
  it("reads a Bearer challenge that follows another scheme", () => {
    expect(
      parseBearerAuthenticateParameters(
        `Basic realm="x", Bearer resource_metadata="${PRM}", scope="mcp:read"`
      )
    ).toEqual({ resource_metadata: PRM, scope: "mcp:read" });
  });

  it("agrees with the acceptance gate on every header it admits", () => {
    for (const header of [
      `Bearer resource_metadata="${PRM}"`,
      `Basic realm="x", Bearer resource_metadata="${PRM}"`,
      `Negotiate, Bearer scope="mcp:read"`,
    ]) {
      expect(hasBearerChallenge(header)).toBe(true);
      expect(parseBearerAuthenticateParameters(header)).not.toEqual({});
    }
  });

  it("keeps a leading Bearer challenge's own params", () => {
    expect(
      parseBearerAuthenticateParameters(
        'Bearer realm="mcp", scope="a b", error="insufficient_scope"'
      )
    ).toEqual({ realm: "mcp", scope: "a b", error: "insufficient_scope" });
  });

  it("does not borrow params from a second Bearer challenge", () => {
    expect(
      parseBearerAuthenticateParameters(
        'Bearer realm="first", Bearer error="insufficient_scope"'
      )
    ).toEqual({ realm: "first" });
  });

  it.each([undefined, "", 'Basic realm="x"'])("yields {} for %s", (header) => {
    expect(
      parseBearerAuthenticateParameters(header as string | undefined)
    ).toEqual({});
  });

  // `auth-param` permits BWS around `=` (RFC 7235 §2.1), which makes a spaced
  // parameter look exactly like a scheme followed by a value. It must stay
  // attached to its challenge rather than opening one named after itself.
  it.each([
    ["space both sides", `Bearer realm="x", scope = "a b"`],
    ["space before", `Bearer realm="x", scope ="a b"`],
    ["space after", `Bearer realm="x", scope= "a b"`],
    ["several spaces", `Bearer realm="x", scope   =   "a b"`],
  ])("keeps a BWS auth-param on its challenge (%s)", (_label, header) => {
    expect(hasBearerChallenge(header)).toBe(true);
    expect(parseBearerAuthenticateParameters(header)).toEqual({
      realm: "x",
      scope: "a b",
    });
  });

  it("keeps a BWS resource_metadata hint readable", () => {
    expect(
      parseBearerAuthenticateParameters(
        `Bearer realm="x", resource_metadata = "${PRM}"`
      )
    ).toEqual({ realm: "x", resource_metadata: PRM });
  });

  // `auth-param` names are the same `token` production as `auth-scheme`, so one
  // may open with a digit. Spelling the name pattern more narrowly than the
  // scheme pattern did not drop the pair — it truncated the name to `fa`.
  it("keeps an auth-param whose name opens with a digit", () => {
    expect(
      parseBearerAuthenticateParameters('Bearer 2fa="totp", scope="mcp:read"')
    ).toEqual({ "2fa": "totp", scope: "mcp:read" });
  });

  it("unescapes quoted-pairs inside a parameter value", () => {
    expect(
      parseBearerAuthenticateParameters('Bearer realm="say \\"hi\\""')
    ).toEqual({ realm: 'say "hi"' });
  });

  it("still splits on a genuine second scheme", () => {
    expect(
      parseBearerAuthenticateParameters('Bearer realm="x", Basic realm="y"')
    ).toEqual({ realm: "x" });
  });

  it("does not mistake a token68 credential for an auth-param", () => {
    const header = 'Negotiate abcdef==, Bearer scope="s"';

    expect(hasBearerChallenge(header)).toBe(true);
    expect(parseBearerAuthenticateParameters(header)).toEqual({ scope: "s" });
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

    it("carries the challenged scopes when Bearer follows another scheme", async () => {
      const state = await driveProbe(protocolVersion, {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "www-authenticate":
            'Basic realm="x", Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
        },
      }).run();

      expect(state.error).toBeUndefined();
      expect(state.currentStep).toBe(challengedStep(protocolVersion));
      // 2025-03-26 has no PRM support and does not track challenged scopes.
      if (protocolVersion !== "2025-03-26") {
        expect(state.challengedScopes).toEqual(["mcp:read"]);
      }
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
