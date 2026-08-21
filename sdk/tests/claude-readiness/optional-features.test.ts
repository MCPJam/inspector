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

  it("is supported only when a probe actually drove it", () => {
    const entry = badge(
      runClaudeOptionalFeatureChecks(
        {
          auth: SERVED_AND_PUBLISHES,
          lazyAuthProbe: {
            unauthenticatedCallSucceeded: true,
            protectedCallChallenged: true,
          },
        },
        STAMP,
      ),
      "claude.features.lazy-authentication",
    );
    expect(entry).toMatchObject({ state: "supported", provenance: "wire" });
  });

  it("is unsupported when a probe drove it and it did not work", () => {
    expect(
      badge(
        runClaudeOptionalFeatureChecks(
          {
            auth: SERVED_AND_PUBLISHES,
            lazyAuthProbe: {
              unauthenticatedCallSucceeded: true,
              protectedCallChallenged: false,
            },
          },
          STAMP,
        ),
        "claude.features.lazy-authentication",
      ).state,
    ).toBe("unsupported");
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
