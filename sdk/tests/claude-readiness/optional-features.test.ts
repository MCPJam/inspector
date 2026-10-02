/**
 * Capability badges.
 *
 * The single rule everything here protects: "we did not look" must never
 * render as "unsupported". A badge that reports a connector as lacking a
 * feature it in fact has is a false statement about someone's product, made on
 * the strength of not having checked.
 */

import { describe, expect, it } from "vitest";

import { runClaudeOptionalFeatureChecks } from "../../src/claude-readiness/checks/optional-features.js";
import { decideLaneStatus } from "../../src/claude-readiness/index.js";
import type { ClaudeAuthEvidence } from "../../src/claude-readiness/checks/auth.js";
import {
  parseChallengeHeader,
  parseToolResultAuthChallenge,
} from "../../src/mcp-client-manager/auth-challenge.js";
import type {
  DirectoryLazyAuthProbeEvidence,
  DirectoryLazyAuthToolCall,
} from "../../src/directory-readiness/lazy-auth.js";

const UNRESOLVED = { schemes: [], source: "unresolved" as const };

function call(
  overrides: Partial<DirectoryLazyAuthToolCall> = {},
): DirectoryLazyAuthToolCall {
  return {
    toolName: "get_weather",
    selectedBy: "named",
    schemes: UNRESOLVED,
    outcome: "succeeded",
    status: 200,
    ...overrides,
  };
}

/** Probe evidence as the probe records it: the refusal parsed by the shared parser. */
function probe(
  protectedCall: DirectoryLazyAuthToolCall | undefined,
  overrides: Partial<DirectoryLazyAuthProbeEvidence> = {},
): DirectoryLazyAuthProbeEvidence {
  return {
    attempted: true,
    protocolVersion: "2025-06-18",
    eraNote: "era",
    initialize: { ok: true, status: 200 },
    publicCall: call(),
    ...(protectedCall ? { protectedCall } : {}),
    ...overrides,
  };
}

const BEARER_401 = call({
  toolName: "get_my_orders",
  outcome: "unauthorized",
  status: 401,
  challenge: parseChallengeHeader(
    'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    "http_401",
  ),
});

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };

const CHALLENGED: ClaudeAuthEvidence = {
  enteredUrl: "https://mcp.example.com/mcp",
  unauthenticated: {
    status: 401,
    representsProtectedOperation: true,
    servedWithoutCredentials: false,
  },
  prm: { discoveredVia: "www-authenticate", document: {} },
};

const SERVED_AND_PUBLISHES: ClaudeAuthEvidence = {
  ...CHALLENGED,
  unauthenticated: {
    status: 200,
    representsProtectedOperation: true,
    servedWithoutCredentials: true,
  },
};

function badge(
  output: ReturnType<typeof runClaudeOptionalFeatureChecks>,
  id: string,
) {
  return output.badges.find((entry) => entry.id === id)!;
}

describe("badges never decide a lane", () => {
  it("leaves the optional-features lane incomplete no matter what it found", () => {
    // `experimental-feature` is not dispositive, so `decideLaneStatus` cannot
    // be moved by any of it — absence of an optional feature is not a defect.
    for (const evidence of [CHALLENGED, SERVED_AND_PUBLISHES]) {
      const output = runClaudeOptionalFeatureChecks({ auth: evidence }, STAMP);
      expect(decideLaneStatus(output.findings)).toBe("incomplete");
      expect(
        output.findings.every((f) => f.class === "experimental-feature"),
      ).toBe(true);
    }
  });
});

describe("lazy authentication", () => {
  it("is not-evaluated — not unsupported — when neither claimed nor detected", () => {
    expect(
      badge(
        runClaudeOptionalFeatureChecks({ auth: CHALLENGED }, STAMP),
        "claude.features.lazy-authentication",
      ),
    ).toMatchObject({ state: "not-evaluated" });
  });

  it("is claimed, not supported, on a consistent-but-undriven observation", () => {
    const entry = badge(
      runClaudeOptionalFeatureChecks({ auth: SERVED_AND_PUBLISHES }, STAMP),
      "claude.features.lazy-authentication",
    );
    expect(entry.state).toBe("claimed");
    expect(entry.detail).toMatch(/not driven/);
  });

  it("is supported only when a probe drove a Bearer 401 after a served public call", () => {
    const entry = badge(
      runClaudeOptionalFeatureChecks(
        { auth: SERVED_AND_PUBLISHES, lazyAuthProbe: probe(BEARER_401) },
        STAMP,
      ),
      "claude.features.lazy-authentication",
    );
    expect(entry).toMatchObject({ state: "supported", provenance: "wire" });
  });

  it("is not evaluated when the 'protected' tool ran without credentials", () => {
    // A protected tool that ran anonymously is not a protected tool: the probe
    // was aimed at the wrong tool, which is not evidence about the design.
    expect(
      badge(
        runClaudeOptionalFeatureChecks(
          {
            auth: SERVED_AND_PUBLISHES,
            lazyAuthProbe: probe(call({ toolName: "get_my_orders" })),
          },
          STAMP,
        ),
        "claude.features.lazy-authentication",
      ).state,
    ).toBe("not-evaluated");
  });

  it("is unsupported for a 401 with no WWW-Authenticate, and says Claude's rule", () => {
    const entry = badge(
      runClaudeOptionalFeatureChecks(
        {
          auth: SERVED_AND_PUBLISHES,
          lazyAuthProbe: probe(
            call({
              toolName: "get_my_orders",
              outcome: "unauthorized",
              status: 401,
              challenge: parseChallengeHeader(undefined, "http_401"),
            }),
          ),
        },
        STAMP,
      ),
      "claude.features.lazy-authentication",
    );
    expect(entry.state).toBe("unsupported");
    expect(entry.detail).toMatch(
      /Claude starts sign-in only on HTTP 401 with WWW-Authenticate/,
    );
  });

  it("is unsupported for a _meta-only challenge, which Claude treats as an ordinary failure", () => {
    const entry = badge(
      runClaudeOptionalFeatureChecks(
        {
          auth: SERVED_AND_PUBLISHES,
          lazyAuthProbe: probe(
            call({
              toolName: "get_my_orders",
              outcome: "tool-error",
              status: 200,
              challenge: parseToolResultAuthChallenge({
                isError: true,
                _meta: {
                  "mcp/www_authenticate": [
                    'Bearer error="invalid_token", error_description="sign in"',
                  ],
                },
              }),
            }),
          ),
        },
        STAMP,
      ),
      "claude.features.lazy-authentication",
    );
    expect(entry.state).toBe("unsupported");
    expect(entry.detail).toMatch(/a 200 isError result is an ordinary tool failure to Claude/);
  });

  it("is unsupported when the server challenges before any call succeeds", () => {
    expect(
      badge(
        runClaudeOptionalFeatureChecks(
          {
            auth: CHALLENGED,
            lazyAuthProbe: probe(undefined, {
              initialize: { ok: false, status: 401 },
              publicCall: undefined,
            }),
          },
          STAMP,
        ),
        "claude.features.lazy-authentication",
      ).state,
    ).toBe("unsupported");
  });

  it("does not say supported without a served public call", () => {
    const output = runClaudeOptionalFeatureChecks(
      {
        auth: SERVED_AND_PUBLISHES,
        claimedFeatures: { lazyAuthentication: true },
        lazyAuthProbe: probe(BEARER_401, {
          publicCall: undefined,
          publicCallSkipped: "no public tool",
        }),
      },
      STAMP,
    );
    const entry = badge(output, "claude.features.lazy-authentication");
    expect(entry.state).toBe("claimed");
    expect(entry.detail).toMatch(/no public call was made/);
  });

  it("unlocks depth on a submitter claim without treating the claim as evidence", () => {
    const output = runClaudeOptionalFeatureChecks(
      { auth: CHALLENGED, claimedFeatures: { lazyAuthentication: true } },
      STAMP,
    );
    const entry = badge(output, "claude.features.lazy-authentication");
    expect(entry).toMatchObject({ state: "claimed", provenance: "declared" });
    expect(
      output.findings.find((f) => f.id === "claude.features.lazy-authentication")
        ?.notEvaluatedReason,
    ).toMatch(/driving a protected call/);
  });
});

describe("enterprise-managed auth", () => {
  it("is not-evaluated when unclaimed, because a probe cannot see it", () => {
    const entry = badge(
      runClaudeOptionalFeatureChecks({ auth: CHALLENGED }, STAMP),
      "claude.features.enterprise-managed-auth",
    );
    expect(entry.state).toBe("not-evaluated");
    expect(entry.detail).toMatch(/cannot be detected/);
  });

  it("is claimed when declared, and says what verifying it would take", () => {
    const entry = badge(
      runClaudeOptionalFeatureChecks(
        { auth: CHALLENGED, claimedFeatures: { enterpriseManagedAuth: true } },
        STAMP,
      ),
      "claude.features.enterprise-managed-auth",
    );
    expect(entry.state).toBe("claimed");
    expect(entry.detail).toMatch(/enterprise tenant/);
  });
});
