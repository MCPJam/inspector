/**
 * The reviewer path's findings, graded by both engines, and the reviewer-only
 * rule: a check that needs the reviewer runs on the reviewer account or is
 * blocked with the reason, never answered from another account (RP2). A
 * blocked reviewer check leaves the default gate; a wrong tenant fails it.
 */

import { describe, expect, it } from "vitest";

import {
  gradeClaudeReadiness,
  type ClaudeReadinessInput,
} from "../../src/claude-readiness/runner.js";
import {
  CLAUDE_CONNECTOR_FLOW,
  directoryVerdict,
  placeDirectoryResults,
  type DirectoryReviewerPathEvidence,
} from "../../src/directory-readiness/index.js";
import { gradeOpenAIReadiness } from "../../src/openai-readiness/runner.js";
import { healthyServerEvidence } from "../openai-readiness/server-fixtures.js";

const URL = "https://mcp.example.com/mcp";
const MISSING =
  "No reviewer account is connected for this submission. Rehearse the reviewer sign-in, then run again.";
const NO_ACCOUNT: DirectoryReviewerPathEvidence = {
  account: { missing: MISSING },
};
const IDENTITY = { tool: "whoami", arguments: {} };
const VERIFIED: DirectoryReviewerPathEvidence = {
  account: { id: "acct_reviewer" },
  identity: {
    outcome: "verified",
    call: IDENTITY,
    observed: { identity: "review@example.com", organization: "Sample Org" },
    expected: { identity: "review@example.com", organization: "Sample Org" },
  },
  fixtures: {
    fixtures: [
      { name: "Sample Project", tool: "list_projects", status: "found" },
    ],
    blockedCases: [],
  },
};

function claude(overrides: Partial<ClaudeReadinessInput> = {}) {
  return gradeClaudeReadiness({
    enteredUrl: URL,
    authMode: "headless",
    capabilities: [],
    startedAt: "2026-08-19T00:00:00.000Z",
    evaluatedAt: "2026-08-19T00:00:01.000Z",
    durationMs: 1,
    endpoint: { enteredUrl: URL, redirectChain: [{ url: URL, status: 200 }] },
    auth: { enteredUrl: URL },
    apps: { enteredUrl: URL, appsSuiteRan: false },
    ...overrides,
  });
}

function finding(result: { findings: readonly { id: string }[] }, id: string) {
  const found = result.findings.find((entry) => entry.id === id);
  if (!found) throw new Error(`no finding ${id}`);
  return found as ReturnType<typeof claude>["findings"][number];
}

/** Checks the Claude flow places as needing the reviewer. */
const REVIEWER_CHECKS = CLAUDE_CONNECTOR_FLOW.placements
  .filter((placement) => placement.needs?.includes("reviewer"))
  .map((placement) => placement.checkId);

describe("a run that graded no submission", () => {
  it("does not apply the reviewer path, and leaves other checks as they were", () => {
    const result = claude();
    expect(finding(result, "both.reviewer.identity").status).toBe(
      "not-applicable"
    );
    expect(finding(result, "both.reviewer.fixtures").status).toBe(
      "not-applicable"
    );
    expect(finding(result, "both.auth.client-signatures")).toMatchObject({
      status: "not-evaluated",
      notEvaluatedReason:
        "This run did not request discovery with other client signatures.",
    });
    expect(
      finding(result, "claude.intrusive.refresh-rotation").notEvaluatedReason
    ).not.toContain(MISSING);
  });
});

describe("the reviewer-only rule", () => {
  it("blocks every check that needs the reviewer, with the reason, when the run has no reviewer account", () => {
    const result = claude({ reviewerPath: NO_ACCOUNT });
    expect(REVIEWER_CHECKS).toEqual(
      expect.arrayContaining([
        "both.reviewer.identity",
        "claude.intrusive.refresh-rotation",
      ])
    );
    for (const id of REVIEWER_CHECKS) {
      const blocked = finding(result, id);
      if (blocked.status === "not-applicable") continue;
      expect(blocked, id).toMatchObject({
        status: "not-evaluated",
        notEvaluatedReason: `blocked: ${MISSING}`,
      });
    }
    expect(
      finding(result, "claude.auth.prm-discoverable").notEvaluatedReason
    ).not.toContain(MISSING);
  });

  it("withdraws a result reached on another account", () => {
    const audience = { auth: { enteredUrl: URL, accessTokenAudience: [URL] } };
    expect(
      finding(claude(audience), "claude.auth.access-token-audience").status
    ).toBe("informational");
    const withdrawn = finding(
      claude({ ...audience, reviewerPath: NO_ACCOUNT }),
      "claude.auth.access-token-audience"
    );
    expect(withdrawn).toMatchObject({
      status: "not-evaluated",
      notEvaluatedReason: `blocked: ${MISSING}`,
    });
    expect(withdrawn.remediation).toBeUndefined();
  });

  it("shows the blocked checks as blocked, outside the default gate unless the gate names them", () => {
    const { findings } = claude({ reviewerPath: NO_ACCOUNT });
    const placed = placeDirectoryResults({
      flow: CLAUDE_CONNECTOR_FLOW,
      answers: [],
      findings,
    })
      .flatMap((step) => step.findings)
      .find((entry) => entry.finding.id === "both.reviewer.identity");
    expect(placed).toMatchObject({
      step: "testLaunch",
      evidenceStatus: "blocked",
    });

    const verdict = directoryVerdict(findings, { path: "hosted" });
    expect(verdict.undetermined).not.toContain("both.reviewer.identity");
    expect(verdict.notCheckedReasons["both.reviewer.identity"]).toBe(
      `blocked: ${MISSING}`
    );
    const gated = directoryVerdict(findings, {
      path: "hosted",
      checkGate: { failOn: ["both.reviewer.identity"] },
    });
    expect(gated.undetermined).toContain("both.reviewer.identity");
  });

  it("does not apply to a submission that says its server needs no sign-in", () => {
    const answer = (value: string) => [
      { key: "authentication.requirement", value, origin: "set" as const },
    ];
    for (const reviewerPath of [NO_ACCOUNT, VERIFIED]) {
      const result = claude({
        reviewerPath,
        submissionAnswers: answer("none"),
      });
      for (const id of REVIEWER_CHECKS) {
        expect(finding(result, id).status, id).toBe("not-applicable");
      }
      for (const id of ["both.reviewer.identity", "both.reviewer.fixtures"]) {
        expect(finding(result, id).notEvaluatedReason, id).toBe(
          "The submission says the server needs no sign-in, so there is no reviewer account to check."
        );
      }
      expect(JSON.stringify(result.findings)).not.toMatch(/rehearse/i);
    }
    // Any other answer still holds the checks to the reviewer account.
    for (const value of ["always", "when-asked"]) {
      const result = claude({
        reviewerPath: NO_ACCOUNT,
        submissionAnswers: answer(value),
      });
      expect(finding(result, "both.reviewer.identity")).toMatchObject({
        status: "not-evaluated",
        notEvaluatedReason: `blocked: ${MISSING}`,
      });
    }
  });

  it("counts a check that does not apply as neither a blocker nor not checked", () => {
    const answer = (value: string) => [
      { key: "authentication.requirement", value, origin: "set" as const },
    ];
    const testLaunch = (value: string, only?: (id: string) => boolean) => {
      const { findings } = claude({
        reviewerPath: NO_ACCOUNT,
        submissionAnswers: answer(value),
      });
      const step = placeDirectoryResults({
        flow: CLAUDE_CONNECTOR_FLOW,
        answers: answer(value),
        findings: findings.filter((finding) => only?.(finding.id) ?? true),
      }).find((entry) => entry.step === "testLaunch");
      if (!step) throw new Error("no testLaunch step");
      return step;
    };
    const reviewer = (id: string) => id.startsWith("both.reviewer.");
    const statuses = (value: string) =>
      testLaunch(value)
        .findings.filter((entry) => reviewer(entry.finding.id))
        .map((entry) => entry.evidenceStatus);
    expect(statuses("none")).toEqual(["established", "established"]);
    // With a sign-in and no reviewer account, the same two are not checked.
    expect(statuses("always")).toEqual(["blocked", "blocked"]);
    // They count in no bucket: the step's counts are the same without them.
    expect(testLaunch("none").counts).toEqual(
      testLaunch("none", (id) => !reviewer(id)).counts
    );
    const { findings } = claude({
      reviewerPath: NO_ACCOUNT,
      submissionAnswers: answer("none"),
    });
    // A gate that names one is settled, not left undetermined.
    const gated = directoryVerdict(findings, {
      path: "hosted",
      checkGate: { failOn: ["both.reviewer.identity"] },
    });
    expect(gated.undetermined).not.toContain("both.reviewer.identity");
  });

  it("lets a server outage stay the reason to fix first", () => {
    const result = claude({
      reviewerPath: NO_ACCOUNT,
      serverFailure: { kind: "unreachable", detail: "fetch failed" },
    });
    expect(finding(result, "both.reviewer.identity").notEvaluatedReason).toBe(
      "blocked: the server could not be reached: fetch failed"
    );
  });
});

describe("the reviewer path's findings", () => {
  it("pass for the verified reviewer and the fixtures it has", () => {
    const result = claude({ reviewerPath: VERIFIED });
    expect(finding(result, "both.reviewer.identity")).toMatchObject({
      status: "satisfied",
      details: { call: IDENTITY, observed: { organization: "Sample Org" } },
    });
    expect(finding(result, "both.reviewer.fixtures").status).toBe("satisfied");
  });

  it("fail the default gate for the wrong tenant (RP4)", () => {
    const { findings } = claude({
      reviewerPath: {
        ...VERIFIED,
        identity: {
          outcome: "wrong-tenant",
          call: IDENTITY,
          observed: { organization: "Other Org" },
          expected: { organization: "Sample Org" },
        },
        fixtures: { blocked: "not looked up", fixtures: [], blockedCases: [] },
      },
    });
    const identity = finding({ findings }, "both.reviewer.identity");
    expect(identity.status).toBe("violated");
    expect(identity.remediation).toContain(
      "answers for organization Other Org, not Sample Org"
    );
    expect(directoryVerdict(findings, { path: "hosted" }).failing).toContain(
      "both.reviewer.identity"
    );
  });

  it("say why the identity is unverified, outside the default gate", () => {
    const { findings } = claude({
      reviewerPath: {
        ...VERIFIED,
        identity: {
          outcome: "unverified",
          reason: "the submission names no identity tool",
        },
      },
    });
    expect(
      finding({ findings }, "both.reviewer.identity").notEvaluatedReason
    ).toBe(
      "blocked: identity unverified: the submission names no identity tool"
    );
    const verdict = directoryVerdict(findings, { path: "hosted" });
    expect(verdict.undetermined).not.toContain("both.reviewer.identity");
    expect(verdict.notCheckedOnPath).toContain("both.reviewer.identity");
  });

  it("name a missing fixture and the cases it blocks (RP5)", () => {
    const result = claude({
      reviewerPath: {
        ...VERIFIED,
        fixtures: {
          fixtures: [
            {
              name: "Missing Project",
              tool: "list_projects",
              status: "missing",
            },
          ],
          blockedCases: [
            { case: "Test cases 2", fixtures: ["Missing Project"] },
          ],
        },
      },
    });
    expect(finding(result, "both.reviewer.fixtures")).toMatchObject({
      status: "violated",
      remediation: expect.stringContaining(
        "The reviewer account has no Missing Project, which Test cases 2 need."
      ),
    });
  });

  it("report a refused client signature with its status and body (RP9)", () => {
    const body = "error code: 1010";
    const result = claude({
      clientSignatures: {
        probes: [
          {
            signature: "mcpjam",
            document: "protected-resource",
            url: URL,
            status: 200,
          },
          {
            signature: "http-library",
            document: "protected-resource",
            url: URL,
            status: 403,
            body,
          },
        ],
      },
    });
    expect(finding(result, "both.auth.client-signatures")).toMatchObject({
      status: "violated",
      remediation: expect.stringContaining(
        "The protected resource metadata answered 403 to Python's HTTP library"
      ),
      details: {
        probes: expect.arrayContaining([
          expect.objectContaining({ status: 403, body }),
        ]),
      },
    });
  });
});

describe("the OpenAI engine", () => {
  function openai(reviewerPath: DirectoryReviewerPathEvidence) {
    return gradeOpenAIReadiness({
      target: "https://plugin.example.com/mcp",
      mode: "mcp-only",
      authMode: "headless",
      capabilities: [],
      startedAt: "2026-11-13T00:00:00.000Z",
      evaluatedAt: "2026-11-13T00:00:01.000Z",
      durationMs: 1,
      ...healthyServerEvidence(),
      reviewerPath,
    });
  }

  it("grades the same reviewer path and holds it to the reviewer account", () => {
    expect(finding(openai(VERIFIED), "both.reviewer.identity").status).toBe(
      "satisfied"
    );
    expect(finding(openai(NO_ACCOUNT), "both.reviewer.fixtures")).toMatchObject(
      {
        status: "not-evaluated",
        notEvaluatedReason: `blocked: ${MISSING}`,
      }
    );
  });
});
