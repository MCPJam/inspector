/**
 * Submission-artifact checks.
 *
 * The lane is dispositive, so these tests are about the line between what a
 * declaration can settle and what it cannot. A profile can prove that five
 * successful test cases were SUPPLIED; nothing in it can prove that the three
 * failure cases fail gracefully, and a check that graded the second from the
 * first would be inventing a verdict.
 */

import { describe, expect, it } from "vitest";

import { runOpenAISubmissionChecks } from "../../src/openai-readiness/checks/submission.js";
import {
  OPENAI_ATTESTATIONS,
  parseOpenAISubmissionProfile,
} from "../../src/openai-readiness/submission-profile.js";
import { completeSubmissionProfile } from "./submission-fixtures.js";

const STAMP = { evaluatedAt: "2026-08-19T12:00:00.000Z" };

function grade(
  overrides: Record<string, unknown> = {},
  extra: { annotatedTools?: string[]; frameDomains?: string[] } = {},
) {
  const parsed = parseOpenAISubmissionProfile(
    completeSubmissionProfile(overrides as never),
  );
  return runOpenAISubmissionChecks(
    { profile: parsed.profile, profileIssues: parsed.issues, ...extra },
    STAMP,
  );
}

const byId = (findings: ReturnType<typeof grade>, id: string) =>
  findings.find((finding) => finding.id === id)!;

describe("with no profile at all", () => {
  it("reports every check unevaluated and names the input", () => {
    const findings = runOpenAISubmissionChecks({ profileIssues: [] }, STAMP);
    expect(findings.length).toBeGreaterThan(5);
    for (const finding of findings) {
      expect(finding.status).toBe("not-evaluated");
      expect(finding.notEvaluatedReason).toBeTruthy();
    }
    expect(
      findings.every(
        (finding) =>
          (finding.details as { missingInput?: string })?.missingInput ===
          "submissionProfile",
      ),
    ).toBe(true);
  });

  it("infers nothing from the absence", () => {
    // The lane's whole shape follows from this: a listing name is a field on a
    // form, and `serverInfo.name` is a different thing that frequently differs.
    const findings = runOpenAISubmissionChecks({ profileIssues: [] }, STAMP);
    expect(findings.some((finding) => finding.status === "satisfied")).toBe(
      false,
    );
  });
});

describe("a malformed profile", () => {
  it("is reported as the caller's mistake, not as absent input", () => {
    const findings = runOpenAISubmissionChecks(
      { profileIssues: ["name: Required"] },
      STAMP,
    );
    const valid = byId(findings, "openai.submission.profile-valid");
    expect(valid.status).toBe("violated");
    expect(valid.remediation).toContain("name: Required");
  });
});

describe("with a complete profile", () => {
  it("passes the deterministic checks", () => {
    const findings = grade();
    for (const id of [
      "openai.submission.listing-fields",
      "openai.submission.urls",
      "openai.submission.test-cases",
      "openai.submission.demo-access",
      "openai.submission.account",
      "openai.submission.geography",
      "openai.submission.attestations",
      "openai.submission.domain-token",
      "openai.submission.scan-currency",
    ]) {
      expect(byId(findings, id).status, id).toBe("satisfied");
    }
  });

  it("keeps the judgement calls unevaluated", () => {
    // Provenance is `declared` on both, so nobody can read "the submitter said
    // so" as "we checked".
    for (const id of [
      "openai.submission.test-case-quality",
      "openai.submission.attestation-truth",
      "openai.submission.privacy-disclosure",
    ]) {
      const finding = byId(grade(), id);
      expect(finding.status, id).toBe("not-evaluated");
      expect(finding.class, id).toBe("manual-review");
      expect(finding.provenance, id).toBe("declared");
      expect(finding.lane, id).toBe("experience-insights");
    }
  });
});

describe("test cases are counted by kind", () => {
  it("fails when the failure cases are short even if the total is right", () => {
    // Eight happy paths satisfies a naive total-of-eight rule, and the failure
    // cases are the ones the requirement exists for.
    const findings = grade({
      testCases: {
        successful: Array.from({ length: 8 }, (_u, index) => ({
          prompt: `p${index}`,
          expectation: `e${index}`,
        })),
        gracefulFailure: [],
      },
    });
    const testCases = byId(findings, "openai.submission.test-cases");
    expect(testCases.status).toBe("violated");
    expect(testCases.remediation).toContain("graceful-failure");
    expect(testCases.details).toMatchObject({
      successful: 8,
      gracefulFailure: 0,
      meetsSuccessMinimum: true,
      meetsFailureMinimum: false,
    });
  });
});

describe("attestations", () => {
  it("names which one is missing rather than counting", () => {
    const attestations = Object.fromEntries(
      OPENAI_ATTESTATIONS.map((attestation) => [attestation, true]),
    );
    delete attestations.keepsListingAccurate;
    const finding = byId(
      grade({ attestations }),
      "openai.submission.attestations",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain("keepsListingAccurate");
  });

  it("separates a refusal from an unfinished form", () => {
    // A key present and `false` is a decision; an absent key is a blank field.
    // Both fail, and a maintainer needs to know which.
    const attestations = Object.fromEntries(
      OPENAI_ATTESTATIONS.map((attestation) => [attestation, true]),
    );
    attestations.noProhibitedContent = false;
    delete attestations.keepsListingAccurate;
    const finding = byId(
      grade({ attestations }),
      "openai.submission.attestations",
    );
    expect(finding.details).toMatchObject({
      missing: expect.arrayContaining([
        "noProhibitedContent",
        "keepsListingAccurate",
      ]),
      refused: ["noProhibitedContent"],
    });
  });
});

describe("release notes", () => {
  it("are not applicable to a first submission", () => {
    // Requiring them here would fail every plugin's first attempt on a field
    // that has nothing to describe.
    const finding = byId(
      grade({ hasPublishedVersion: false }),
      "openai.submission.release-notes",
    );
    expect(finding.status).toBe("not-applicable");
  });

  it("are required once a version is published", () => {
    expect(
      byId(
        grade({ hasPublishedVersion: true, releaseNotes: undefined }),
        "openai.submission.release-notes",
      ).status,
    ).toBe("violated");
    expect(
      byId(
        grade({ hasPublishedVersion: true, releaseNotes: "Fixed a thing." }),
        "openai.submission.release-notes",
      ).status,
    ).toBe("satisfied");
  });
});

describe("demo access", () => {
  it("does not demand credentials from an authless plugin", () => {
    const finding = byId(
      grade({
        demoCredentials: { provided: false, delivery: "not-required-authless" },
      }),
      "openai.submission.demo-access",
    );
    expect(finding.status).toBe("satisfied");
  });

  it("still demands a recording from an authless plugin", () => {
    const finding = byId(
      grade({
        demoCredentials: { provided: false, delivery: "not-required-authless" },
        demoRecordingProvided: false,
      }),
      "openai.submission.demo-access",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain("recording");
  });
});

describe("justifications are matched to what was observed", () => {
  it("is not applicable when nothing was annotated", () => {
    expect(
      byId(grade(), "openai.submission.annotation-justifications").status,
    ).toBe("not-applicable");
  });

  it("names the tools still lacking one", () => {
    const finding = byId(
      grade(
        { annotationJustifications: { deleteThing: "it deletes a thing" } },
        { annotatedTools: ["deleteThing", "searchWeb"] },
      ),
      "openai.submission.annotation-justifications",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain("searchWeb");
    expect(finding.remediation).not.toContain("deleteThing");
  });

  it("does the same for frame domains", () => {
    const finding = byId(
      grade({}, { frameDomains: ["maps.example.com"] }),
      "openai.submission.frame-domain-explanations",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain("maps.example.com");
  });
});

describe("the account", () => {
  it("fails without the app-write permission", () => {
    const finding = byId(
      grade({ accountPermissions: [] }),
      "openai.submission.account",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain("api.apps.write");
  });

  it("fails without identity verification", () => {
    expect(
      byId(grade({ identityVerified: false }), "openai.submission.account")
        .status,
    ).toBe("violated");
  });
});

describe("scan currency", () => {
  it("is unevaluated rather than failed when no timestamp was declared", () => {
    // Nobody said the scan was stale; nobody said it was fresh either.
    const finding = byId(
      grade({ lastScanAt: undefined }),
      "openai.submission.scan-currency",
    );
    expect(finding.status).toBe("not-evaluated");
  });

  it("passes a scan dated before the run, and records its age", () => {
    const finding = byId(
      grade({ lastScanAt: "2026-08-19T11:00:00.000Z" }),
      "openai.submission.scan-currency",
    );
    expect(finding.status).toBe("satisfied");
    // The age is for a reader to judge staleness with; this check does not
    // decide staleness, because deciding it needs the contract's age too.
    expect((finding.details as { ageMs?: number }).ageMs).toBe(60 * 60 * 1000);
  });

  it("does not pass a scan timestamp it cannot read", () => {
    // `Date.parse` answers NaN rather than throwing, and `NaN > runAt` is
    // false — so an unreadable value would slide past the future-date test
    // into `satisfied`, with the age it could not compute quietly absent.
    //
    // BYPASSING `grade` ON PURPOSE. The profile schema types this field as an
    // ISO-8601 datetime and rejects every unparseable string, so the only way
    // to reach the branch is the way a caller could: hand the exported
    // function a profile that never met the schema. That is precisely the
    // caller this guard is for, and a test that could not construct one would
    // be testing the schema instead of the check.
    const parsed = parseOpenAISubmissionProfile(completeSubmissionProfile());
    const finding = runOpenAISubmissionChecks(
      {
        profile: { ...parsed.profile!, lastScanAt: "sometime last week" },
        profileIssues: [],
      },
      STAMP,
    ).find((entry) => entry.id === "openai.submission.scan-currency")!;
    expect(finding.status).toBe("not-evaluated");
    expect(finding.notEvaluatedReason).toContain("not a readable date");
  });

  it("fails a scan timestamp that postdates the run", () => {
    // A time later than the run cannot describe a scan that has already
    // happened, so it is a clock or a copy-paste — either way the date is not
    // evidence of anything, and passing on it would be the presence of a field
    // standing in for the fact it claims.
    const finding = byId(
      grade({ lastScanAt: "2027-01-01T00:00:00.000Z" }),
      "openai.submission.scan-currency",
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toContain("later than this run");
  });

  it("claims only what the profile settles", () => {
    // The title used to say the scan was CURRENT while the code tested only
    // that a timestamp existed — a six-month-old scan passed a `required`
    // check about freshness.
    const finding = byId(
      grade({ lastScanAt: "2026-08-19T11:00:00.000Z" }),
      "openai.submission.scan-currency",
    );
    expect(finding.title).not.toContain("current");
  });
});
