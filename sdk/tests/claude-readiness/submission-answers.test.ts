/**
 * The submission lane graded from a connector submission's answers: the
 * portal's own rules and words, no screenshots, and the Authentication step
 * standing in for the old profile's declared auth mode.
 */

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { claudeSubmissionEvidenceFromAnswers } from "../../src/claude-readiness/answers.js";
import { runClaudeSubmissionChecks } from "../../src/claude-readiness/checks/submission.js";
import {
  gradeClaudeReadiness,
  type ClaudeReadinessInput,
} from "../../src/claude-readiness/runner.js";
import type { DirectoryAnswer } from "../../src/directory-readiness/index.js";
import {
  ACKNOWLEDGMENT_VALUES,
  answer,
  completeAnswers,
} from "../support/claude-connector-answers.js";

const STAMP = { evaluatedAt: "2026-08-19T00:00:00.000Z" };
const URL_UNDER_TEST = "https://mcp.example.com/mcp";

function grade(answers: DirectoryAnswer[], observedAuthMode?: string) {
  return runClaudeSubmissionChecks(
    { answers: claudeSubmissionEvidenceFromAnswers(answers), observedAuthMode },
    STAMP
  );
}

function byId(findings: ReturnType<typeof grade>, id: string) {
  const found = findings.filter((finding) => finding.id === id);
  expect(found, id).toHaveLength(1);
  return found[0];
}

describe("evidence from answers", () => {
  it("fills in the portal's defaults and reads the declared auth mode", () => {
    const evidence = claudeSubmissionEvidenceFromAnswers([]);
    expect(evidence.values["authentication.oauthClient"]).toBe("dcr");
    expect(evidence.declaredAuthMode).toBe("oauth-dcr");
  });

  it("maps every Authentication answer to the engine's vocabulary", () => {
    const mode = (requirement: string, client: string) =>
      claudeSubmissionEvidenceFromAnswers([
        answer("authentication.requirement", requirement),
        answer("authentication.oauthClient", client),
      ]).declaredAuthMode;
    expect(mode("always", "cimd")).toBe("oauth-cimd");
    expect(mode("when-asked", "anthropic-held")).toBe("oauth-preregistered");
    expect(mode("always", "bring-your-own")).toBe("oauth-preregistered");
    expect(mode("none", "dcr")).toBe("authless");
    expect(mode("", "dcr")).toBeUndefined();
    expect(mode("always", "toString")).toBeUndefined();
  });

  it("carries the review page's issues, the author included", () => {
    const evidence = claudeSubmissionEvidenceFromAnswers(
      completeAnswers([answer("company.website", "http://acme.example")])
    );
    expect(evidence.issues.map((issue) => issue.key)).toEqual([
      "listing.authorName",
    ]);
  });
});

describe("the listing checks graded from answers", () => {
  it("pass a submission the portal would accept", () => {
    const findings = grade(completeAnswers());
    for (const id of [
      "claude.submission.listing-fields",
      "claude.submission.urls",
      "claude.submission.attestations",
    ]) {
      expect(byId(findings, id).status, id).toBe("satisfied");
    }
    expect(
      byId(findings, "claude.submission.listing-fields").details
    ).toMatchObject({
      oneLinerLength: 29,
      limits: { oneLiner: 200, description: 2000, categoriesMax: 5 },
    });
  });

  it("give the limit error for a 201-character one-liner", () => {
    const finding = byId(
      grade(completeAnswers([answer("listing.oneLiner", "x".repeat(201))])),
      "claude.submission.listing-fields"
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      "Fix this answer before you submit. One-liner: Use 200 characters or fewer. This has 201."
    );
    expect(finding.details).toMatchObject({
      oneLinerLength: 201,
      issues: [{ key: "listing.oneLiner", code: "tooLong" }],
    });
  });

  it("report each missing answer in the portal's words", () => {
    const finding = byId(
      grade(
        completeAnswers([
          answer("listing.slug", ""),
          answer("listing.categories", []),
          answer("company.website", "http://acme.example"),
        ])
      ),
      "claude.submission.listing-fields"
    );
    expect(finding.remediation).toBe(
      "Fix these answers before you submit. Slug: Slug is required. Categories: Select at least one category. Author: An author is required to submit — add one on the Listing step, or fill in your company name and an https:// website to use those."
    );
  });

  it("accept a support email and refuse a plaintext documentation link", () => {
    expect(
      byId(grade(completeAnswers()), "claude.submission.urls").details
    ).toMatchObject({
      links: { "listing.support": "support@acme.example" },
    });
    const finding = byId(
      grade(
        completeAnswers([
          answer("listing.documentationUrl", "http://acme.example/docs"),
        ])
      ),
      "claude.submission.urls"
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      "Fix this answer before you submit. Documentation: Enter a full https:// URL."
    );
  });

  it("hold all seven acknowledgments to the portal's line", () => {
    const finding = byId(
      grade(
        completeAnswers([
          answer(
            "compliance.acknowledgments",
            ACKNOWLEDGMENT_VALUES.slice(0, 6)
          ),
        ])
      ),
      "claude.submission.attestations"
    );
    expect(finding.status).toBe("violated");
    expect(finding.remediation).toBe(
      "Fix this answer before you submit. Policies acknowledged: All policy items must be acknowledged."
    );
    expect(finding.details).toMatchObject({ acknowledged: 6 });
  });

  it("find no screenshots to check on a connector submission", () => {
    const findings = grade(completeAnswers());
    for (const id of [
      "claude.submission.screenshots",
      "claude.submission.screenshot-prompts",
    ]) {
      expect(byId(findings, id).status, id).toBe("not-applicable");
    }
  });

  it("leave the declared auth mode to the wire, and fail a contradiction", () => {
    const unobserved = byId(
      grade(completeAnswers()),
      "claude.submission.declared-auth-mode"
    );
    expect(unobserved.status).toBe("not-evaluated");
    expect(unobserved.details).toEqual({ declared: "oauth-dcr" });

    const contradicted = byId(
      grade(
        completeAnswers([answer("authentication.requirement", "none")]),
        "oauth-dcr"
      ),
      "claude.submission.declared-auth-mode"
    );
    expect(contradicted.status).toBe("violated");
  });

  it("keep quality and ownership for a reviewer", () => {
    const finding = byId(
      grade(completeAnswers()),
      "claude.submission.artifact-quality"
    );
    expect(finding.status).toBe("informational");
    expect(finding.details).toMatchObject({
      declaredDataHandling: {
        apiOwnership: "own",
        healthData: "no",
        sponsored: "no",
      },
    });
  });
});

describe("the grader with submission answers", () => {
  function input(
    overrides: Partial<ClaudeReadinessInput> = {}
  ): ClaudeReadinessInput {
    return {
      enteredUrl: URL_UNDER_TEST,
      authMode: "headless",
      capabilities: ["dns"],
      startedAt: "2026-08-19T00:00:00.000Z",
      evaluatedAt: "2026-08-19T00:00:01.000Z",
      durationMs: 1000,
      endpoint: {
        enteredUrl: URL_UNDER_TEST,
        redirectChain: [{ url: URL_UNDER_TEST, status: 200 }],
      },
      auth: {
        enteredUrl: URL_UNDER_TEST,
        unauthenticated: {
          status: 401,
          wwwAuthenticate:
            'Bearer resource_metadata="https://mcp.example.com/prm"',
          representsProtectedOperation: true,
          servedWithoutCredentials: false,
        },
        prm: {
          discoveredVia: "www-authenticate",
          document: {
            resource: URL_UNDER_TEST,
            authorization_servers: ["https://auth.example.com"],
          },
        },
        // No registration endpoint and no client metadata documents: only a
        // client registered out of band can sign in.
        firstAuthorizationServer: {
          issuer: "https://auth.example.com",
          reachable: true,
          document: {
            code_challenge_methods_supported: ["S256"],
            response_types_supported: ["code"],
          },
        },
      },
      apps: { enteredUrl: URL_UNDER_TEST, appsSuiteRan: true, tools: [] },
      tools: [
        {
          name: "list_orders",
          title: "List orders",
          annotations: { title: "List orders", readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        } as Tool,
      ],
      ...overrides,
    };
  }
  const status = (input: ClaudeReadinessInput, id: string) =>
    gradeClaudeReadiness(input).findings.find((finding) => finding.id === id)
      ?.status;

  it("grades the submission lane from the answers", () => {
    const result = gradeClaudeReadiness(
      input({ submissionAnswers: completeAnswers() })
    );
    const artifacts = result.lanes.find(
      (lane) => lane.lane === "submission-artifacts"
    );
    expect(artifacts?.coverage.missingInputs).toEqual([]);
    expect(
      status(
        input({ submissionAnswers: completeAnswers() }),
        "claude.submission.listing-fields"
      )
    ).toBe("satisfied");
  });

  it("lets an Anthropic-held client reclassify the acquisition path", () => {
    const id = "claude.auth.client-acquisition-path";
    expect(status(input({ submissionAnswers: completeAnswers() }), id)).toBe(
      "violated"
    );
    expect(
      status(
        input({
          submissionAnswers: completeAnswers([
            answer("authentication.oauthClient", "anthropic-held"),
          ]),
        }),
        id
      )
    ).toBe("satisfied");
  });

  it("ignores a profile passed beside the answers", () => {
    const result = gradeClaudeReadiness(
      input({
        submissionAnswers: completeAnswers(),
        submissionProfile: { name: "only a name" },
      })
    );
    const listing = result.findings.find(
      (finding) => finding.id === "claude.submission.listing-fields"
    );
    expect(listing?.status).toBe("satisfied");
  });

  it("still grades a profile when no answers are given", () => {
    const result = gradeClaudeReadiness(
      input({ submissionProfile: { name: "only a name" } })
    );
    const listing = result.findings.find(
      (finding) => finding.id === "claude.submission.listing-fields"
    );
    expect(listing?.notEvaluatedReason).toMatch(/did not validate/);
  });
});
