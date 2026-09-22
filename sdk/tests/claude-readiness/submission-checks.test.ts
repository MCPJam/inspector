/**
 * The submission-artifacts lane, whose defining property is what it does
 * WITHOUT its input.
 *
 * Reporting `ready` for a lane a wire-only run cannot evaluate would be the
 * single most damaging thing this product could do — a submitter would take it
 * to Anthropic and be rejected on the fields we implied we had checked. So the
 * no-profile case is tested first and hardest.
 */

import { describe, expect, it } from "vitest";

import {
  runClaudeSubmissionChecks,
  CLAUDE_SUBMISSION_PROFILE_INPUT,
} from "../../src/claude-readiness/checks/submission.js";
import {
  CLAUDE_ATTESTATIONS,
  parseClaudeSubmissionProfile,
  type ClaudeSubmissionProfile,
} from "../../src/claude-readiness/submission-profile.js";
import { decideLaneStatus } from "../../src/claude-readiness/index.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };

function validProfile(
  overrides: Partial<ClaudeSubmissionProfile> = {},
): ClaudeSubmissionProfile {
  return {
    name: "Acme Orders",
    tagline: "Look up and track Acme orders",
    description: "Connects Claude to the Acme order system.",
    categories: ["Productivity"],
    slug: "acme-orders",
    documentationUrl: "https://acme.example/docs",
    privacyPolicyUrl: "https://acme.example/privacy",
    supportUrl: "https://acme.example/support",
    iconUrl: "https://acme.example/icon.png",
    declaredAuthMode: "oauth-dcr",
    dataHandling: ["processes-user-data"],
    screenshots: [1, 2, 3].map((n) => ({
      url: `https://acme.example/shot-${n}.png`,
      mimeType: "image/png",
      widthPx: 1440,
      heightPx: 900,
      prompt: `Show me order ${n}`,
    })),
    attestations: Object.fromEntries(
      CLAUDE_ATTESTATIONS.map((attestation) => [attestation, true]),
    ) as ClaudeSubmissionProfile["attestations"],
    ...overrides,
  };
}

function byId(findings: ReturnType<typeof runClaudeSubmissionChecks>, id: string) {
  return findings.find((finding) => finding.id === id)!;
}

describe("with no submission profile", () => {
  const findings = runClaudeSubmissionChecks({}, STAMP);

  it("evaluates nothing rather than inferring", () => {
    expect(
      findings.every((finding) => finding.status === "not-evaluated"),
    ).toBe(true);
  });

  it("leaves the lane incomplete, never ready", () => {
    expect(decideLaneStatus(findings)).toBe("incomplete");
  });

  it("names the input that would close the gap", () => {
    for (const finding of findings) {
      expect(finding.details).toMatchObject({
        missingInput: CLAUDE_SUBMISSION_PROFILE_INPUT,
      });
    }
  });

  it("says explicitly that serverInfo.name is not the listing name", () => {
    expect(findings[0].notEvaluatedReason).toMatch(/serverInfo\.name/);
  });

  it("distinguishes a malformed profile from an absent one", () => {
    const malformed = runClaudeSubmissionChecks(
      { profileIssues: ["tagline: String must contain at most 55 character(s)"] },
      STAMP,
    );
    expect(malformed[0].notEvaluatedReason).toMatch(/did not validate/);
    expect(malformed[0].notEvaluatedReason).toMatch(/tagline/);
  });
});

describe("with a valid profile", () => {
  it("marks the deterministic requirements satisfied", () => {
    const findings = runClaudeSubmissionChecks(
      { profile: validProfile(), observedAuthMode: "oauth-dcr" },
      STAMP,
    );
    expect(decideLaneStatus(findings)).toBe("ready");
  });

  it("keeps quality and ownership as manual review with declared provenance", () => {
    const finding = byId(
      runClaudeSubmissionChecks({ profile: validProfile() }, STAMP),
      "claude.submission.artifact-quality",
    );
    // `declared` is what stops a reader taking "the submitter said so" for
    // "we verified it".
    expect(finding.class).toBe("manual-review");
    expect(finding.provenance).toBe("declared");
    expect(finding.status).toBe("informational");
  });
});

describe("screenshots", () => {
  it("rejects a non-PNG", () => {
    const profile = validProfile();
    profile.screenshots[0].mimeType = "image/jpeg";
    expect(
      byId(runClaudeSubmissionChecks({ profile }, STAMP), "claude.submission.screenshots")
        .status,
    ).toBe("violated");
  });

  it("rejects one narrower than the minimum", () => {
    const profile = validProfile();
    profile.screenshots[1].widthPx = 800;
    const finding = byId(
      runClaudeSubmissionChecks({ profile }, STAMP),
      "claude.submission.screenshots",
    );
    expect(finding.status).toBe("violated");
    expect(finding.details).toMatchObject({ tooNarrow: [{ widthPx: 800 }] });
  });

  it("tolerates a charset parameter on the mime type", () => {
    const profile = validProfile();
    profile.screenshots[0].mimeType = "image/png; charset=binary";
    expect(
      byId(runClaudeSubmissionChecks({ profile }, STAMP), "claude.submission.screenshots")
        .status,
    ).toBe("satisfied");
  });
});

describe("attestations", () => {
  it("tells an unanswered attestation apart from a declined one", () => {
    const profile = validProfile();
    delete (profile.attestations as Record<string, boolean>)
      .respondsToSecurityReports;
    profile.attestations.noProhibitedContent = false;

    const finding = byId(
      runClaudeSubmissionChecks({ profile }, STAMP),
      "claude.submission.attestations",
    );
    expect(finding.status).toBe("violated");
    expect(finding.details).toMatchObject({
      unanswered: ["respondsToSecurityReports"],
      declined: ["noProhibitedContent"],
    });
    expect(finding.remediation).toMatch(/unanswered and some are declined/);
  });
});

describe("the declared auth mode", () => {
  it("is left unchallenged when the run could not observe one", () => {
    const finding = byId(
      runClaudeSubmissionChecks({ profile: validProfile() }, STAMP),
      "claude.submission.declared-auth-mode",
    );
    expect(finding.status).toBe("not-evaluated");
  });

  it("fails on a positive contradiction", () => {
    const finding = byId(
      runClaudeSubmissionChecks(
        { profile: validProfile({ declaredAuthMode: "authless" }), observedAuthMode: "oauth-dcr" },
        STAMP,
      ),
      "claude.submission.declared-auth-mode",
    );
    expect(finding.status).toBe("violated");
  });

  it("does not punish a truthful static-header declaration", () => {
    // A static-header server is indistinguishable from an authless one on the
    // wire; failing this would penalise an honest submitter for our blind spot.
    const finding = byId(
      runClaudeSubmissionChecks(
        {
          profile: validProfile({ declaredAuthMode: "static-header" }),
          observedAuthMode: "authless",
        },
        STAMP,
      ),
      "claude.submission.declared-auth-mode",
    );
    expect(finding.status).toBe("satisfied");
  });
});

describe("the profile schema", () => {
  it("accepts a valid profile", () => {
    expect(parseClaudeSubmissionProfile(validProfile()).profile).toBeDefined();
  });

  it("reports each issue with its field path", () => {
    const { profile, issues } = parseClaudeSubmissionProfile({
      ...validProfile(),
      tagline: "x".repeat(56),
      documentationUrl: "http://acme.example/docs",
      categories: [],
    });
    expect(profile).toBeUndefined();
    expect(issues.join("\n")).toMatch(/tagline/);
    expect(issues.join("\n")).toMatch(/documentationUrl.*https/s);
    expect(issues.join("\n")).toMatch(/categories/);
  });

  it("requires https on every listing link", () => {
    expect(
      parseClaudeSubmissionProfile(
        validProfile({ privacyPolicyUrl: "http://acme.example/privacy" }),
      ).profile,
    ).toBeUndefined();
  });

  it("bounds the screenshot count on both sides", () => {
    const profile = validProfile();
    expect(
      parseClaudeSubmissionProfile({ ...profile, screenshots: profile.screenshots.slice(0, 2) })
        .profile,
    ).toBeUndefined();
    expect(
      parseClaudeSubmissionProfile({
        ...profile,
        screenshots: [...profile.screenshots, ...profile.screenshots],
      }).profile,
    ).toBeUndefined();
  });

  it("rejects a slug that is not kebab-case", () => {
    expect(
      parseClaudeSubmissionProfile(validProfile({ slug: "Acme Orders" })).profile,
    ).toBeUndefined();
  });
});
