/**
 * The semantics a headless OAuth exam lives or dies by.
 *
 * `not-applicable` leaves a score's denominator entirely; `could-not-run`
 * stays in it as an unearned point. Collapsing the two is how a run that
 * reached a third of the suite comes to print full marks, so every arm of that
 * distinction is pinned here.
 */

import { describe, expect, it } from "vitest";
import { reconcileHeadlessOAuthScope } from "../conformance-oauth-headless-scope";
import type { ConformanceReport } from "@mcpjam/sdk";

const SCOPE = [
  "oauth_unauthenticated_challenge",
  "oauth_resource_metadata_challenge",
  "generate_pkce_parameters",
  "received_authorization_code",
];

function report(
  cases: Array<{
    id: string;
    status: "passed" | "failed" | "skipped";
    skipReason?: "not-applicable" | "could-not-run";
    error?: string;
  }>,
): ConformanceReport {
  return {
    schemaVersion: 1,
    kind: "oauth-conformance",
    name: "OAuth Conformance",
    passed: true,
    outcome: "passed",
    durationMs: 12,
    score: {
      score: 100,
      outcome: "passed",
      applicable: cases.length,
      passed: cases.length,
      failed: 0,
      couldNotRun: 0,
      notApplicable: 0,
      pending: 0,
      advisories: [],
      advicePointsLost: 0,
      protocolVersion: "2025-11-25",
    },
    groups: [
      {
        id: "oauth-1",
        title: "2025-11-25/dcr",
        target: "https://connector.example.com/mcp",
        passed: true,
        durationMs: 12,
        cases: cases.map((entry) => ({
          category: "oauth",
          title: entry.id,
          durationMs: 1,
          ...entry,
        })),
      },
    ],
  };
}

describe("reconcileHeadlessOAuthScope", () => {
  it("records a client_credentials-inapplicable step as could-not-run, not not-applicable", () => {
    // The SDK's runner marks the authorization-code leg `not-applicable` under
    // client_credentials — true of the GRANT, false of a target that
    // advertises the code flow. Honoring that verdict is what would let a
    // headless exam claim full marks on the third of the suite it can reach.
    const result = reconcileHeadlessOAuthScope({
      report: report([
        { id: "oauth_unauthenticated_challenge", status: "passed" },
        { id: "oauth_resource_metadata_challenge", status: "passed" },
        {
          id: "generate_pkce_parameters",
          status: "skipped",
          skipReason: "not-applicable",
          error: "The client_credentials grant has no authorization-code leg",
        },
        {
          id: "received_authorization_code",
          status: "skipped",
          skipReason: "not-applicable",
          error: "The client_credentials grant has no authorization-code leg",
        },
      ]),
      checkIds: SCOPE,
    });

    expect(result.couldNotRun).toEqual([
      "generate_pkce_parameters",
      "received_authorization_code",
    ]);
    expect(result.notApplicable).toEqual([]);
    const cases = result.report.groups[0]!.cases;
    for (const id of ["generate_pkce_parameters", "received_authorization_code"]) {
      expect(cases.find((entry) => entry.id === id)).toMatchObject({
        status: "skipped",
        skipReason: "could-not-run",
      });
    }
    // Unearned points stay in the denominator, so the run cannot read as clean.
    expect(result.report.score?.couldNotRun).toBe(2);
    expect(result.report.score?.notApplicable).toBe(0);
    expect(result.report.score?.applicable).toBe(4);
    expect(result.report.outcome).toBe("incomplete");
    expect(result.report.passed).toBe(false);
  });

  it("keeps not-applicable only when the target serves without challenging", () => {
    // The runner's ONE structural marker for "authorization is OPTIONAL and
    // this server does not require it".
    const result = reconcileHeadlessOAuthScope({
      report: report([
        {
          id: "request_without_token",
          status: "skipped",
          skipReason: "not-applicable",
          error: "the server answered an unauthenticated initialize",
        },
      ]),
      checkIds: SCOPE,
    });

    expect(result.couldNotRun).toEqual([]);
    expect(result.notApplicable).toEqual(SCOPE);
    expect(result.report.score?.couldNotRun).toBe(0);
    expect(result.report.score?.notApplicable).toBe(SCOPE.length);
    // Nothing applicable ⇒ nothing to claim a number about.
    expect(result.report.score?.score).toBeNull();
    expect(result.report.outcome).toBe("passed");
  });

  it("synthesizes an in-scope check the run never produced a case for", () => {
    const result = reconcileHeadlessOAuthScope({
      report: report([
        { id: "oauth_unauthenticated_challenge", status: "passed" },
      ]),
      checkIds: SCOPE,
    });

    expect(result.missing).toEqual([
      "oauth_resource_metadata_challenge",
      "generate_pkce_parameters",
      "received_authorization_code",
    ]);
    expect(result.report.groups[0]!.cases).toHaveLength(SCOPE.length);
    expect(result.report.score?.couldNotRun).toBe(3);
    expect(result.report.score?.applicable).toBe(4);
  });

  it("reports an out-of-scope check without grading it", () => {
    const result = reconcileHeadlessOAuthScope({
      report: report([
        { id: "oauth_unauthenticated_challenge", status: "passed" },
        { id: "oauth_resource_metadata_challenge", status: "passed" },
        { id: "generate_pkce_parameters", status: "passed" },
        { id: "received_authorization_code", status: "passed" },
        { id: "oauth_invalid_redirect", status: "failed", error: "boom" },
      ]),
      checkIds: SCOPE,
    });

    const outOfScope = result.report.groups[0]!.cases.find(
      (entry) => entry.id === "oauth_invalid_redirect",
    );
    // Its verdict survives verbatim — it just is not part of this exam.
    expect(outOfScope).toMatchObject({ status: "failed", pending: true });
    expect(result.report.score?.pending).toBe(1);
    expect(result.report.score?.failed).toBe(0);
    expect(result.report.outcome).toBe("passed");
  });

  it("drops a stale incompleteReason when the reconciled verdict is not incomplete", () => {
    const stale = report([
      { id: "oauth_unauthenticated_challenge", status: "passed" },
      { id: "oauth_resource_metadata_challenge", status: "passed" },
      { id: "generate_pkce_parameters", status: "passed" },
      { id: "received_authorization_code", status: "passed" },
    ]);
    stale.incompleteReason = "1 of 9 selected check(s) could not run";

    const result = reconcileHeadlessOAuthScope({
      report: stale,
      checkIds: SCOPE,
    });

    expect(result.report.outcome).toBe("passed");
    expect(result.report.incompleteReason).toBeUndefined();
  });

  it("leaves the report untouched when no scope is pinned", () => {
    const source = report([
      { id: "oauth_invalid_redirect", status: "failed", error: "boom" },
    ]);
    // "This exam does not grade OAuth" must not become "the exam found
    // nothing": blanking every case would be a claim.
    expect(reconcileHeadlessOAuthScope({ report: source, checkIds: [] }).report).toBe(
      source,
    );
  });
});
