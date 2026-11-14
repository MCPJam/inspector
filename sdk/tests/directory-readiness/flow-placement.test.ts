/**
 * Findings placed on the portal's steps, each with how far it can still be
 * trusted. The engine runs below are real: an unreachable server must leave
 * the answer-graded checks standing and block only what needed the server.
 */

import type { Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
  gradeClaudeReadiness,
  type ClaudeReadinessInput,
} from "../../src/claude-readiness/runner.js";
import {
  CLAUDE_CONNECTOR_FLOW as FLOW,
  placeDirectoryResults,
  type DirectoryAnswer,
  type DirectoryReadinessFinding,
  type PlacedStep,
} from "../../src/directory-readiness/index.js";
import {
  ACKNOWLEDGMENT_VALUES,
  answer,
  completeAnswers,
} from "../support/claude-connector-answers.js";

const URL_UNDER_TEST = "https://mcp.example.com/mcp";

function run(overrides: Partial<ClaudeReadinessInput> = {}) {
  return gradeClaudeReadiness({
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
      firstAuthorizationServer: {
        issuer: "https://auth.example.com",
        reachable: true,
        document: {
          registration_endpoint: "https://auth.example.com/register",
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
    submissionAnswers: completeAnswers(),
    ...overrides,
  });
}

const UNREACHABLE: Partial<ClaudeReadinessInput> = {
  endpoint: { enteredUrl: URL_UNDER_TEST, redirectChain: [] },
  auth: { enteredUrl: URL_UNDER_TEST },
  apps: { enteredUrl: URL_UNDER_TEST, appsSuiteRan: false },
  tools: undefined,
};

function place(
  findings: readonly DirectoryReadinessFinding[],
  answers: readonly DirectoryAnswer[] = completeAnswers(),
  gradedAnswers?: readonly DirectoryAnswer[]
) {
  return placeDirectoryResults({
    flow: FLOW,
    answers,
    findings,
    gradedAnswers,
  });
}

function placed(steps: PlacedStep[], checkId: string) {
  const found = steps
    .flatMap((step) => step.findings)
    .filter((entry) => entry.finding.id === checkId);
  expect(found, checkId).toHaveLength(1);
  return found[0];
}

function finding(
  id: string,
  rest: Partial<DirectoryReadinessFinding> = {}
): DirectoryReadinessFinding {
  return {
    id,
    title: id,
    lane: "experience-insights",
    class: "heuristic",
    status: "informational",
    source: {},
    provenance: "llm",
    intrusiveness: "passive",
    evaluatedAt: "2026-08-19T00:00:01.000Z",
    engineVersion: "1",
    ...rest,
  };
}

describe("where results land", () => {
  it("returns every step in the portal's order, found or not", () => {
    const steps = place([]);
    expect(steps.map((step) => step.step)).toEqual(
      FLOW.steps.map((step) => step.id)
    );
    expect(steps.every((step) => step.findings.length === 0)).toBe(true);
  });

  it("puts a check under the step and field its placement names", () => {
    const steps = place(run().findings);
    expect(placed(steps, "claude.endpoint.https")).toMatchObject({
      step: "connection",
      field: "connection.serverUrl",
    });
    expect(placed(steps, "claude.submission.listing-fields").step).toBe(
      "listing"
    );
    expect(placed(steps, "claude.submission.attestations")).toMatchObject({
      step: "compliance",
      field: "compliance.acknowledgments",
    });
  });

  it("sends an unplaced check to its lane's step, and an unknown lane to the last", () => {
    const steps = place([
      finding("claude.future.check", { lane: "directory-policy" }),
      finding("claude.other.check", { lane: "a-lane-nobody-knows" }),
    ]);
    expect(placed(steps, "claude.future.check").step).toBe("tools");
    expect(placed(steps, "claude.other.check").step).toBe("review");
  });
});

describe("evidence status", () => {
  it("is established for a settled result", () => {
    const steps = place(run().findings);
    expect(placed(steps, "claude.submission.listing-fields")).toMatchObject({
      evidenceStatus: "established",
    });
    expect(placed(steps, "claude.tools.title-present").evidenceStatus).toBe(
      "established"
    );
  });

  it("blocks only what needed the unreachable server", () => {
    const steps = place(run(UNREACHABLE).findings);
    for (const id of [
      "claude.endpoint.redirects-stay-https",
      "claude.tools.title-present",
      "claude.auth.unauthenticated-challenge",
      "claude.submission.declared-auth-mode",
    ]) {
      expect(placed(steps, id).evidenceStatus, id).toBe("blocked");
      expect(placed(steps, id).finding.notEvaluatedReason, id).toBeTruthy();
    }
    for (const id of [
      "claude.endpoint.https",
      "claude.submission.listing-fields",
      "claude.submission.urls",
      "claude.submission.attestations",
    ]) {
      expect(placed(steps, id).evidenceStatus, id).toBe("established");
    }
  });

  it("blocks a check whose runner capability the run lacked", () => {
    const steps = place(run().findings);
    expect(placed(steps, "claude.intrusive.refresh-rotation")).toMatchObject({
      evidenceStatus: "blocked",
      finding: { notEvaluatedReason: "intrusive probes were not requested" },
    });
    expect(
      placed(steps, "claude.auth.rfc8707-resource-canonical").evidenceStatus
    ).toBe("blocked");
  });

  it("reads a lacked capability from the run's own verdicts", () => {
    // Nothing that needs a browser reached a verdict, so the browser check is
    // blocked; once one did, the same skip is only not-tested.
    const browserCheck = finding("claude.apps.instance-supersession", {
      lane: "experience-insights",
      provenance: "browser",
      status: "not-evaluated",
      requiresCapabilities: ["browser"],
      notEvaluatedReason: "this run had no browser capability",
    });
    const rendered = finding("claude.apps.design.doctype", {
      provenance: "browser",
      status: "satisfied",
      requiresCapabilities: ["browser"],
    });
    expect(placed(place([browserCheck]), browserCheck.id).evidenceStatus).toBe(
      "blocked"
    );
    expect(
      placed(place([browserCheck, rendered]), browserCheck.id).evidenceStatus
    ).toBe("not-tested");
  });

  it("is not-tested when the run had what the check needs and still skipped it", () => {
    // The server answered, so the lazy-auth badge was simply not asked for.
    const steps = place(run().findings);
    expect(
      placed(steps, "claude.features.lazy-authentication").evidenceStatus
    ).toBe("not-tested");
  });

  it("is inconclusive for a model's flag it was unsure of", () => {
    const unsure = finding("claude.experience.tool-overlap", {
      details: { confidence: "low" },
    });
    const sure = finding("claude.experience.tool-descriptions-uninformative", {
      details: { confidence: "high" },
    });
    const review = finding("claude.experience.consent-scope-unclear", {
      class: "manual-review",
      details: { confidence: "low" },
    });
    const steps = place([unsure, sure, review]);
    expect(placed(steps, unsure.id).evidenceStatus).toBe("inconclusive");
    expect(placed(steps, sure.id).evidenceStatus).toBe("established");
    expect(placed(steps, review.id).evidenceStatus).toBe("established");
  });
});

describe("staleness", () => {
  const graded = completeAnswers();
  const findings = run({ submissionAnswers: graded }).findings;

  it("marks only results that read a changed answer", () => {
    const now = completeAnswers([
      answer("listing.oneLiner", "Track Acme orders"),
    ]);
    const steps = place(findings, now, graded);
    expect(placed(steps, "claude.submission.listing-fields")).toMatchObject({
      evidenceStatus: "stale",
      staleBecause: ["listing.oneLiner"],
    });
    expect(placed(steps, "claude.submission.urls").evidenceStatus).toBe(
      "established"
    );
    expect(
      placed(steps, "claude.submission.urls").staleBecause
    ).toBeUndefined();
  });

  it("follows a changed server to every server result", () => {
    const now = completeAnswers([
      answer("connection.serverUrl", "https://other.example.com/mcp"),
    ]);
    const steps = place(findings, now, graded);
    expect(placed(steps, "claude.tools.title-present")).toMatchObject({
      evidenceStatus: "stale",
      staleBecause: ["connection.serverUrl"],
    });
  });

  it("marks an unsure flag stale when an answer it read changed", () => {
    const unsure = finding("claude.experience.tool-overlap", {
      details: { confidence: "low" },
    });
    const now = completeAnswers([
      answer("connection.serverUrl", "https://other.example.com/mcp"),
    ]);
    const [entry] = place([unsure], now, graded).flatMap(
      (step) => step.findings
    );
    expect(entry).toMatchObject({
      evidenceStatus: "stale",
      staleBecause: ["connection.serverUrl"],
    });
  });

  it("counts a confirmation under new wording as a change", () => {
    const confirm = (wordingRevision: string): DirectoryAnswer => ({
      ...answer("compliance.acknowledgments", ACKNOWLEDGMENT_VALUES),
      origin: "confirmed",
      wordingRevision,
    });
    const steps = place(
      findings,
      completeAnswers([confirm("acknowledgments-2")]),
      completeAnswers([confirm("acknowledgments-1")])
    );
    expect(placed(steps, "claude.submission.attestations")).toMatchObject({
      evidenceStatus: "stale",
      staleBecause: ["compliance.acknowledgments"],
    });
  });

  it("ignores the order of a row's keys and the merged defaults", () => {
    const reordered = completeAnswers([
      answer("useCases.pairs", [
        { examplePrompt: "Where is order 1042?", useCase: "Track an order" },
      ]),
      answer("dataHandling.healthData", "no"),
    ]);
    const steps = place(findings, reordered, graded);
    const all = steps.flatMap((step) => step.findings);
    expect(all.filter((entry) => entry.evidenceStatus === "stale")).toEqual([]);
  });

  it("is never claimed without the answers the run graded", () => {
    const now = completeAnswers([answer("listing.oneLiner", "Different")]);
    const all = place(findings, now).flatMap((step) => step.findings);
    expect(all.some((entry) => entry.evidenceStatus === "stale")).toBe(false);
  });
});

describe("the declaration and scan checks", () => {
  it("land under the answer they read, the acknowledgments and the review page", () => {
    const steps = place(run().findings);
    expect(
      placed(steps, "claude.submission.access-matches-annotations")
    ).toMatchObject({ step: "useCases", field: "useCases.access" });
    expect(
      placed(steps, "claude.scan.cross-tool-direction-candidates")
    ).toMatchObject({
      step: "compliance",
      field: "compliance.acknowledgments",
    });
    expect(placed(steps, "claude.submission.declarations-confirmed").step).toBe(
      "review"
    );
  });

  it("go stale when the answer they read changes or is confirmed", () => {
    const graded = completeAnswers();
    const findings = run({ submissionAnswers: graded }).findings;
    const now = completeAnswers([
      {
        key: "useCases.access",
        value: "read-only",
        origin: "confirmed",
        wordingRevision: FLOW.version,
      },
    ]);
    const steps = place(findings, now, graded);
    for (const id of [
      "claude.submission.access-matches-annotations",
      "claude.submission.declarations-confirmed",
    ]) {
      expect(placed(steps, id), id).toMatchObject({
        evidenceStatus: "stale",
        staleBecause: ["useCases.access"],
      });
    }
  });
});

describe("a failure the run names", () => {
  it("is blocked even when another check with the same need reached a verdict", () => {
    const answered = finding("claude.auth.prm-discoverable", {
      lane: "runtime-compatibility",
      class: "runtime-blocker",
      provenance: "wire",
      status: "satisfied",
    });
    const refused = finding("claude.tools.title-present", {
      lane: "directory-policy",
      class: "required",
      provenance: "static",
      status: "not-evaluated",
      notEvaluatedReason:
        "blocked: the connection to the server failed: initialize answered 401",
    });
    const skipped = finding("claude.tools.name-length", {
      lane: "directory-policy",
      class: "required",
      provenance: "static",
      status: "not-evaluated",
      notEvaluatedReason: "no tool listing was captured for this run",
    });
    const steps = place([answered, refused, skipped]);
    expect(placed(steps, refused.id).evidenceStatus).toBe("blocked");
    expect(placed(steps, skipped.id).evidenceStatus).toBe("not-tested");
  });
});

describe("step counts", () => {
  it("count field issues, blockers, flags, gaps and passes per step", () => {
    const answers = completeAnswers([
      answer("listing.oneLiner", "x".repeat(201)),
      answer("listing.slug", ""),
    ]);
    const findings = [
      ...run({ submissionAnswers: answers }).findings,
      finding("claude.experience.listing-copy-placeholder"),
    ];
    const listing = place(findings, answers).find(
      (step) => step.step === "listing"
    );
    expect(listing?.fieldIssues.map((issue) => issue.key)).toEqual([
      "listing.slug",
      "listing.oneLiner",
    ]);
    expect(listing?.counts).toEqual({
      toFix: 2,
      blockers: 1,
      likelyFlags: 1,
      notChecked: 0,
      passed: 1,
    });
  });

  it("count an issue for a field the flow does not have where an unplaced check goes", () => {
    // An answer stored before the flow dropped its field.
    const answers = completeAnswers([
      answer("listing.tagline", "Track orders"),
    ]);
    const unplaced = finding("claude.other.check", {
      lane: "a-lane-nobody-knows",
    });
    const steps = place([unplaced], answers);
    const fallback = placed(steps, unplaced.id).step;
    expect(
      steps.flatMap((step) =>
        step.fieldIssues.map((issue) => [step.step, issue.key, issue.code])
      )
    ).toEqual([[fallback, "listing.tagline", "unknownField"]]);
    expect(steps.find((step) => step.step === fallback)?.counts.toFix).toBe(1);
  });

  it("report the review page's issues when asked", () => {
    const answers = completeAnswers([
      answer("company.website", "http://acme.example"),
    ]);
    const listing = (on: "form" | "review") =>
      placeDirectoryResults({ flow: FLOW, answers, on }).find(
        (step) => step.step === "listing"
      );
    expect(listing("form")?.counts.toFix).toBe(0);
    expect(listing("review")?.fieldIssues.map((issue) => issue.key)).toEqual([
      "listing.authorName",
    ]);
  });
});
