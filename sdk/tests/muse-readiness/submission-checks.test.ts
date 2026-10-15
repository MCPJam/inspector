/**
 * Submission checks: what the submitter declares, graded field by field so a
 * partial profile still grades what it holds.
 */

import { describe, expect, it } from "vitest";

import { runMuseSubmissionChecks } from "../../src/muse-readiness/checks/submission.js";
import type { MuseToolEvidence } from "../../src/muse-readiness/classification.js";
import {
  parseMuseSubmissionProfile,
  type MuseSubmissionProfile,
} from "../../src/muse-readiness/submission-profile.js";
import { COMPLETE_PROFILE } from "./fixtures.js";

const STAMP = { evaluatedAt: "2026-10-07T00:00:00.000Z" };

const TOOLS: MuseToolEvidence[] = [
  { name: "search_rooms", annotations: { readOnlyHint: true } },
  { name: "book_room", annotations: { readOnlyHint: false } },
];

function run(profile: MuseSubmissionProfile | undefined, tools = TOOLS) {
  return runMuseSubmissionChecks({ profile, tools }, STAMP);
}

function byId(findings: ReturnType<typeof run>, id: string) {
  const match = findings.find((entry) => entry.id === id);
  if (!match) throw new Error(`no finding ${id}`);
  return match;
}

describe("without a profile", () => {
  it("evaluates nothing and names submissionProfile", () => {
    const findings = run(undefined);
    expect(findings).toHaveLength(10);
    for (const entry of findings) {
      expect(entry.status).toBe("not-evaluated");
      expect(entry.provenance).toBe("declared");
      expect(entry.details).toMatchObject({
        missingInput: "submissionProfile",
      });
    }
  });

  it("carries a malformed profile's issues instead of claiming there was none", () => {
    const parsed = parseMuseSubmissionProfile({
      authentication: { method: "magic" },
    });
    expect(parsed.profile).toBeUndefined();
    const findings = runMuseSubmissionChecks(
      { profileIssues: parsed.issues, tools: TOOLS },
      STAMP
    );
    expect(findings[0]!.notEvaluatedReason).toContain("authentication.method");
  });
});

describe("a complete profile", () => {
  it("satisfies every check", () => {
    const findings = run(COMPLETE_PROFILE);
    expect(
      findings
        .filter((entry) => entry.status !== "satisfied")
        .map((entry) => entry.id)
    ).toEqual([]);
  });

  it("parses — every field it uses is in the schema", () => {
    expect(parseMuseSubmissionProfile(COMPLETE_PROFILE).issues).toEqual([]);
  });
});

describe("a partial profile grades what it holds", () => {
  it("grades classifications alone and reports every other declaration as missing", () => {
    const findings = run({
      toolClassifications: { search_rooms: "read", book_room: "write" },
    });
    expect(byId(findings, "muse.submission.tool-classifications").status).toBe(
      "satisfied"
    );
    expect(
      byId(findings, "muse.submission.classification-consistent").status
    ).toBe("satisfied");
    expect(byId(findings, "muse.submission.overview").status).toBe("violated");
    expect(byId(findings, "muse.submission.test-account").status).toBe(
      "violated"
    );
  });

  it("parses with a single attestation answered — a missing key is not a parse error", () => {
    const parsed = parseMuseSubmissionProfile({
      attestations: { acceptsDeveloperTerms: true },
    });
    expect(parsed.issues).toEqual([]);
    const entry = byId(run(parsed.profile), "muse.submission.attestations");
    expect(entry.status).toBe("violated");
    expect(entry.details).toMatchObject({
      unanswered: [
        "businessVerificationProvided",
        "brandAssetsAuthorized",
        "maintainerNamed",
        "dataProcessingQuestionnaireCompleted",
      ],
      refused: [],
    });
  });
});

describe("field shapes", () => {
  it("rejects a plaintext privacy URL and a malformed security contact", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        privacyPolicyUrl: "http://cedar.example/privacy",
        securityContact: "security at cedar",
      }),
      "muse.submission.contacts"
    );
    expect(entry.details).toMatchObject({
      problems: [
        "privacyPolicyUrl must be an https:// URL",
        "securityContact must be an https:// URL or an email address",
      ],
    });
  });

  it("names the documentation topics that are not covered", () => {
    const entry = byId(
      run({ ...COMPLETE_PROFILE, documentationCovers: ["setup-instructions"] }),
      "muse.submission.tool-documentation"
    );
    expect(entry.status).toBe("violated");
    expect((entry.details as { uncovered: string[] }).uncovered).toHaveLength(
      8
    );
  });

  it("requires scopes and an environment for OAuth credentials", () => {
    const entry = byId(
      run({ ...COMPLETE_PROFILE, authentication: { method: "oauth" } }),
      "muse.submission.integration-credentials"
    );
    expect(entry.details).toMatchObject({
      problems: [
        "an OAuth connector must list the scopes Muse will request",
        "say whether the credentials are for a test or a production environment",
      ],
    });
  });
});

describe("muse.submission.read-only-option (§3.1, recommended)", () => {
  it("is not applicable without OAuth", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        authentication: { method: "api-key", credentialsEnvironment: "test" },
      }),
      "muse.submission.read-only-option"
    );
    expect(entry.status).toBe("not-applicable");
  });

  it("accepts a stated reason when read-only is not possible", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        authentication: {
          method: "oauth",
          scopes: ["all"],
          readOnlyNotPossibleReason:
            "The provider's OAuth has a single all-access scope.",
          credentialsEnvironment: "test",
        },
      }),
      "muse.submission.read-only-option"
    );
    expect(entry.status).toBe("satisfied");
  });

  it("is violated, but never dispositive, without either", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        authentication: {
          method: "oauth",
          scopes: ["all"],
          credentialsEnvironment: "test",
        },
      }),
      "muse.submission.read-only-option"
    );
    expect(entry).toMatchObject({ status: "violated", class: "recommended" });
  });

  it("catches a read-only scope Muse would never request", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        authentication: {
          method: "oauth",
          scopes: ["stays.book"],
          readOnlyScopes: ["stays.read"],
          credentialsEnvironment: "test",
        },
      }),
      "muse.submission.read-only-option"
    );
    expect(entry.details).toMatchObject({ notRequested: ["stays.read"] });
  });
});

describe("muse.submission.no-charge-test-path (§5.5)", () => {
  it("is not applicable when the submitter declares no transaction tools", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        transactions: { hasTransactionTools: false },
      }),
      "muse.submission.no-charge-test-path"
    );
    expect(entry.status).toBe("not-applicable");
  });

  it("is violated when transaction tools have no no-charge test path", () => {
    const entry = byId(
      run({ ...COMPLETE_PROFILE, transactions: { hasTransactionTools: true } }),
      "muse.submission.no-charge-test-path"
    );
    expect(entry.status).toBe("violated");
  });

  it("is a gap, not a pass, when the profile does not say", () => {
    const { transactions: _omit, ...rest } = COMPLETE_PROFILE;
    const entry = byId(run(rest), "muse.submission.no-charge-test-path");
    expect(entry.status).toBe("not-evaluated");
  });
});

describe("classifications against the listing", () => {
  it("names every unclassified tool", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        toolClassifications: { search_rooms: "read" },
      }),
      "muse.submission.tool-classifications"
    );
    expect(entry.details).toMatchObject({ unclassified: ["book_room"] });
  });

  it("reports a declared tool the listing lacks without failing on it", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        toolClassifications: {
          ...COMPLETE_PROFILE.toolClassifications,
          cancel_booking: "write",
        },
      }),
      "muse.submission.tool-classifications"
    );
    expect(entry).toMatchObject({
      status: "satisfied",
      details: { declaredButNotListed: ["cancel_booking"] },
    });
  });

  it("flags a tool declared Read that the server itself says writes", () => {
    const entry = byId(
      run({
        ...COMPLETE_PROFILE,
        toolClassifications: { search_rooms: "read", book_room: "read" },
      }),
      "muse.submission.classification-consistent"
    );
    expect(entry).toMatchObject({
      status: "violated",
      class: "required",
      details: {
        tools: [
          { tool: "book_room", reasons: ["declares readOnlyHint: false"] },
        ],
      },
    });
  });

  it("does not treat an ABSENT hint as a contradiction", () => {
    const entry = byId(
      run({ ...COMPLETE_PROFILE, toolClassifications: { lookup: "read" } }, [
        { name: "lookup" },
      ]),
      "muse.submission.classification-consistent"
    );
    expect(entry.status).toBe("satisfied");
  });

  it("is a gap without a listing to compare against", () => {
    const findings = runMuseSubmissionChecks(
      { profile: COMPLETE_PROFILE },
      STAMP
    );
    expect(
      byId(findings, "muse.submission.tool-classifications")
    ).toMatchObject({
      status: "not-evaluated",
      details: { missingInput: "toolListing" },
    });
  });
});
