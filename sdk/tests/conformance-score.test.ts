/**
 * The conformance score: every applicable check is worth one point, the score
 * is the share that passed rounded DOWN to one decimal, and SHOULD/MAY advice
 * is worth 0. The denominator rules from `conformance-outcome.ts` keep the
 * number honest. Every property asserted here is one a caller will quote to a
 * server author, so each has a test: not-applicable costs nothing,
 * could-not-run keeps a run below 100, advice never moves the number, and 100
 * means "every applicable check ran and passed".
 */

import {
  computeConformanceScore,
  describeConformanceScore,
  pooledConformanceScore,
  scoreFromAppsResult,
  scoreFromOAuthResult,
  scoreFromProtocolResult,
  scoreFromTasksResult,
  type ConformanceScore,
} from "../src/conformance-score.js";
import type { OutcomeCheckLike } from "../src/conformance-outcome.js";
import { toConformanceReport } from "../src/conformance-reporting.js";
import type { MCPConformanceResult } from "../src/mcp-conformance/types.js";
import type { ConformanceResult as OAuthConformanceResult } from "../src/oauth-conformance/types.js";

function check(
  id: string,
  status: OutcomeCheckLike["status"],
  skipReason?: "not-applicable" | "could-not-run",
): OutcomeCheckLike {
  return {
    id,
    status,
    ...(skipReason ? { skipReason } : {}),
    ...(skipReason === "could-not-run"
      ? { error: { message: `${id} could not run` } }
      : {}),
  };
}

function passing(count: number): OutcomeCheckLike[] {
  return Array.from({ length: count }, (_, index) =>
    check(`check-${index + 1}`, "passed"),
  );
}

describe("computeConformanceScore", () => {
  it("scores 100 when every applicable check passed, advice or not", () => {
    const clean = computeConformanceScore(passing(26));
    expect(clean.score).toBe(100);
    expect(clean.outcome).toBe("passed");

    const withAdvice = computeConformanceScore(passing(26), [
      { id: "readiness-deprecated-feature-use", tier: "should" },
    ]);
    expect(withAdvice.score).toBe(100);
    expect(withAdvice.outcome).toBe("passed");
    expect(withAdvice.advisories).toHaveLength(1);
    expect(withAdvice.advicePointsLost).toBe(0);
  });

  it("leaves not-applicable checks out of the denominator entirely — the no-auth case", () => {
    const checks = [
      ...passing(11),
      ...Array.from({ length: 9 }, (_, index) =>
        check(`oauth-${index + 1}`, "skipped", "not-applicable"),
      ),
    ];
    const score = computeConformanceScore(checks);

    expect(score.applicable).toBe(11);
    expect(score.notApplicable).toBe(9);
    expect(score.score).toBe(100);
  });

  it.each(["tasksProbe", "logProbe", "inputRequiredProbe", "toolCallProbe"])(
    "leaves missing %s input unscored while keeping the run incomplete",
    (missingInput) => {
      const score = computeConformanceScore([
        ...passing(25),
        {
          ...check("missing", "skipped", "could-not-run"),
          details: { missingInput },
        },
      ]);
      expect(score).toMatchObject({
        score: 100,
        applicable: 25,
        couldNotRun: 1,
        failed: 0,
        outcome: "incomplete",
      });
      const pooled = pooledConformanceScore([
        score,
        computeConformanceScore(passing(5)),
      ]);
      expect(pooled).toMatchObject({
        score: 100,
        applicable: 30,
        couldNotRun: 1,
        outcome: "incomplete",
      });
    }
  );

  it("has no score when every selected check needs input", () => {
    const score = computeConformanceScore([
      {
        ...check("missing", "skipped", "could-not-run"),
        details: { missingInput: "tasksProbe" },
      },
    ]);
    expect(score).toMatchObject({
      score: null,
      applicable: 0,
      couldNotRun: 1,
      outcome: "incomplete",
    });
  });

  it("keeps execution failures in the denominator", () => {
    const score = computeConformanceScore([
      ...passing(25),
      check("unrun", "skipped", "could-not-run"),
    ]);

    expect(score.outcome).toBe("incomplete");
    expect(score.applicable).toBe(26);
    // 25/26 = 96.15%.
    expect(score.score).toBe(96.1);
  });

  it("scores a failed or incomplete run as the share that passed, advice aside", () => {
    const blocked = computeConformanceScore(
      Array.from({ length: 36 }, (_, index) =>
        check(`unrun-${index}`, "skipped", "could-not-run"),
      ),
      [{ id: "advice", tier: "should" }],
    );
    expect(blocked.outcome).toBe("incomplete");
    expect(blocked.score).toBe(0);

    const failing = computeConformanceScore(
      [
        ...passing(22),
        check("failed-1", "failed"),
        check("failed-2", "failed"),
        check("failed-3", "failed"),
      ],
      [{ id: "advice", tier: "should" }],
    );
    expect(failing.score).toBe(88);
  });

  it("rounds down to one decimal, so a run with any failure never shows 100", () => {
    const score = (passed: number, failed: number) =>
      computeConformanceScore([
        ...passing(passed),
        ...Array.from({ length: failed }, (_, index) =>
          check(`failed-${index}`, "failed")
        ),
      ]).score;

    expect(score(149, 1)).toBe(99.3);
    expect(score(199, 1)).toBe(99.5);
    // Rounding to nearest would print 100 here.
    expect(score(1999, 1)).toBe(99.9);
    expect(score(2, 1)).toBe(66.6);
    expect(score(150, 0)).toBe(100);
  });

  it("gives SHOULD and MAY advice 0 points, however much fired", () => {
    const advisories = Array.from({ length: 40 }, (_, index) => ({
      id: `advice-${index + 1}`,
      tier: index % 2 === 0 ? ("should" as const) : ("may" as const),
    }));
    const advised = computeConformanceScore(passing(10), advisories);

    // SEP-2484: SHOULD-level findings are warnings, not failures.
    expect(advised.score).toBe(100);
    expect(advised.advisories).toHaveLength(40);
    expect(advised.advicePointsLost).toBe(0);
    expect(advised.outcome).toBe("passed");

    // So any failure ranks below a clean run, whatever advice it carries.
    const oneFailure = computeConformanceScore([
      ...passing(25),
      check("failed", "failed"),
    ]);
    expect(oneFailure.score).toBeLessThan(advised.score!);
  });

  it("returns null when nothing was applicable — no number over a vacuous run", () => {
    const score = computeConformanceScore([
      check("a", "skipped", "not-applicable"),
      check("b", "skipped", "not-applicable"),
    ]);

    expect(score.score).toBeNull();
    expect(score.applicable).toBe(0);
    expect(score.notApplicable).toBe(2);
  });

  it("takes the outcome word from the shared verdict logic, never the arithmetic", () => {
    const failed = computeConformanceScore([
      ...passing(3),
      check("bad", "failed"),
    ]);
    expect(failed.outcome).toBe("failed");
    // 3/4 = 75%: a failed run scores its passed share.
    expect(failed.score).toBe(75);
  });
});

describe("pooledConformanceScore", () => {
  it("sums counts so a small suite cannot drown inside a large one", () => {
    const protocol = computeConformanceScore(passing(30));
    const oauth = computeConformanceScore(
      Array.from({ length: 9 }, (_, index) => check(`o-${index}`, "failed")),
    );

    const pooled = pooledConformanceScore([protocol, oauth]);

    expect(pooled.applicable).toBe(39);
    expect(pooled.passed).toBe(30);
    expect(pooled.failed).toBe(9);
    // 30/39 = 76.9% — an average of suite scores (a naive mean of 100 and 0
    // is 50) would say something different; summing is what keeps the 0-for-9
    // OAuth run visible.
    expect(pooled.score).toBe(76.9);
    expect(pooled.outcome).toBe("failed");
  });

  it("lets a scoreless part contribute only its not-applicable tally", () => {
    const protocol = computeConformanceScore(passing(20));
    const oauthNotApplicable: ConformanceScore = {
      score: null,
      outcome: "passed",
      applicable: 0,
      passed: 0,
      failed: 0,
      couldNotRun: 0,
      notApplicable: 5,
      pending: 0,
      advisories: [],
      advicePointsLost: 0,
    };

    const pooled = pooledConformanceScore([protocol, oauthNotApplicable]);

    expect(pooled.score).toBe(100);
    expect(pooled.applicable).toBe(20);
    expect(pooled.notApplicable).toBe(5);
  });

  it("labels the pool only when every scoring part states the same version", () => {
    const a = computeConformanceScore(passing(2), [], "2025-11-25");
    const b = computeConformanceScore(passing(2), [], "2025-11-25");
    expect(pooledConformanceScore([a, b]).protocolVersion).toBe("2025-11-25");

    const c = computeConformanceScore(passing(2), [], "2026-07-28");
    expect(pooledConformanceScore([a, c]).protocolVersion).toBeUndefined();

    // A part that judged checks WITHOUT establishing a version bars the label:
    // claiming 2025-11-25 for a pool containing versionless judgements would
    // overstate what was judged against.
    const versionless = computeConformanceScore(passing(2));
    expect(pooledConformanceScore([a, versionless]).protocolVersion).toBeUndefined();

    // A scoreless part constrains nothing — it judged nothing.
    const scoreless = computeConformanceScore([
      check("na", "skipped", "not-applicable"),
    ]);
    expect(pooledConformanceScore([a, scoreless]).protocolVersion).toBe(
      "2025-11-25",
    );
  });

  it("takes the worst outcome, failure outranking incomplete", () => {
    const incomplete = computeConformanceScore([
      check("u", "skipped", "could-not-run"),
    ]);
    const failed = computeConformanceScore([check("f", "failed")]);
    const passed = computeConformanceScore(passing(1));

    expect(pooledConformanceScore([passed, incomplete]).outcome).toBe(
      "incomplete",
    );
    expect(pooledConformanceScore([passed, incomplete, failed]).outcome).toBe(
      "failed",
    );
  });
});

describe("describeConformanceScore", () => {
  it.each([
    [0, 1, 0, "not scored. 1 check needs input"],
    [0, 7, 0, "not scored. 7 checks need input"],
    [1, 7, 0, "100/100 — 1/1 applicable checks passed, 7 checks need input"],
    [
      1,
      2,
      3,
      "25/100 — 1/4 applicable checks passed, 2 checks need input, 3 could not run",
    ],
  ])(
    "names missing inputs separately with %i passed, %i missing and %i other unrun",
    (passed, missing, otherUnrun, expected) => {
      const score = computeConformanceScore([
        ...passing(passed),
        ...Array.from({ length: missing }, (_, index) => ({
          ...check(`missing-${index}`, "skipped", "could-not-run"),
          details: { missingInput: "tasksProbe" },
        })),
        ...Array.from({ length: otherUnrun }, (_, index) =>
          check(`timeout-${index}`, "skipped", "could-not-run")
        ),
      ]);
      expect(describeConformanceScore(score)).toBe(expected);
    }
  );

  it("always shows the number, the denominator, and the version", () => {
    const line = describeConformanceScore(
      computeConformanceScore(
        [...passing(24), check("f1", "failed"), check("f2", "failed")],
        [{ id: "advice", tier: "should" }],
        "2025-11-25",
      ),
    );

    expect(line).toBe(
      "92.3/100 — 24/26 applicable checks passed, 2 failed, 1 advisory [2025-11-25]"
    );
  });

  it("says why there is no number instead of inventing one", () => {
    const line = describeConformanceScore(
      computeConformanceScore([check("a", "skipped", "not-applicable")]),
    );
    expect(line).toBe("not scored — 0 applicable checks (1 not applicable)");
  });
});

describe("suite adapters", () => {
  function protocolResult(
    overrides: Partial<MCPConformanceResult> = {},
  ): MCPConformanceResult {
    return {
      passed: true,
      outcome: "passed",
      serverUrl: "https://mcp.example.com/mcp",
      protocolVersion: "2025-11-25",
      checks: [
        {
          id: "ping",
          category: "core",
          title: "Ping",
          description: "Ping.",
          status: "passed",
          durationMs: 1,
        },
        {
          id: "tools-list",
          category: "tools",
          title: "Tools List",
          description: "List tools.",
          status: "skipped",
          skipReason: "not-applicable",
          durationMs: 0,
        },
      ],
      summary: "",
      durationMs: 1,
      categorySummary: {} as MCPConformanceResult["categorySummary"],
      readiness: [
        {
          id: "readiness-deprecated-feature-use",
          title: "Deprecated Feature Use",
          severity: "warning",
          specStrength: "SHOULD",
          message: "…",
        },
        {
          id: "readiness-session-termination",
          title: "Explicit Session Termination",
          severity: "warning",
          specStrength: "MAY",
          message: "…",
        },
      ],
      ...overrides,
    };
  }

  it("maps protocol readiness onto tiers by spec strength", () => {
    const score = scoreFromProtocolResult(
      protocolResult({
        readiness: [
          {
            id: "readiness-tool-order-deterministic",
            title: "Deterministic Tool Order",
            severity: "warning",
            specStrength: "SHOULD",
            message: "…",
          },
        ],
      }),
    );

    expect(score.advisories).toEqual([
      { id: "readiness-tool-order-deterministic", tier: "should" },
    ]);
    expect(score.score).toBe(100);
    expect(score.protocolVersion).toBe("2025-11-25");
  });

  it("lists protocol readiness advice without letting it move the score", () => {
    const score = scoreFromProtocolResult(protocolResult());
    // 1/1 applicable passed; the SHOULD and MAY advice are worth 0.
    expect(score.advisories).toHaveLength(2);
    expect(score.score).toBe(100);
    expect(score.notApplicable).toBe(1);
  });

  /**
   * Advice about behavior the spec EXPLICITLY PERMITS — a MAY the server is
   * entitled to take, or a non-normative example — is reported but not listed
   * as an advisory. `readiness.ts` says as much in prose about the
   * protocol-version header ("reported and never scored").
   */
  it("leaves informational advice out of the advisory list", () => {
    const score = scoreFromProtocolResult(
      protocolResult({
        readiness: [
          {
            id: "readiness-protocol-version-header-required",
            title: "Protocol Version Header Required",
            severity: "warning",
            specStrength: "SHOULD",
            message: "…",
            informational: true,
          },
          {
            id: "readiness-tool-name-conventions",
            title: "Tool Name Conventions",
            severity: "warning",
            specStrength: "SHOULD",
            message: "…",
            informational: true,
          },
        ],
      }),
    );

    expect(score.advisories).toEqual([]);
    expect(score.score).toBe(100);
  });

  it("counts untyped apps/tasks check warnings at the weakest tier", () => {
    const base = {
      passed: true,
      outcome: "passed" as const,
      target: "node server.js",
      summary: "",
      durationMs: 1,
      categorySummary: {},
      checks: [
        {
          id: "ui-tools-present",
          category: "tools",
          title: "UI Tools Present",
          description: "…",
          status: "passed" as const,
          durationMs: 1,
          warnings: ["tool foo has no description", "tool bar has no title"],
        },
      ],
    };

    const apps = scoreFromAppsResult({
      ...base,
      discovery: {
        toolCount: 1,
        uiToolCount: 1,
        listedResourceCount: 0,
        listedUiResourceCount: 0,
        checkedUiResourceCount: 0,
      },
    } as never);

    expect(apps.advisories).toHaveLength(2);
    expect(apps.advisories.every((advisory) => advisory.tier === "may")).toBe(
      true,
    );
    expect(apps.score).toBe(100);

    const tasks = scoreFromTasksResult({
      ...base,
      discovery: {
        protocolVersion: "2025-11-25",
        wire: "extension",
        toolCount: 1,
        taskCapableToolCount: 1,
      },
    } as never);
    expect(tasks.protocolVersion).toBe("2025-11-25");
  });

  it("lists typed tasks readiness by spec strength, informational left out", () => {
    const tasksResult = (informational: boolean, pending = false) =>
      ({
        passed: true,
        outcome: "passed" as const,
        target: "node server.js",
        summary: "",
        durationMs: 1,
        categorySummary: {},
        checks: [
          {
            id: "tasks-status-payload-shape",
            category: "lifecycle",
            title: "Status Payload Shape",
            description: "…",
            status: "passed" as const,
            durationMs: 1,
          },
        ],
        readiness: [
          {
            id: "tasks-readiness-failed-status-message",
            checkId: "tasks-status-payload-shape",
            title: "Failed Task Status Message",
            severity: "warning",
            specStrength: "SHOULD",
            message: "…",
            ...(informational ? { informational: true } : {}),
          },
        ],
        ...(pending
          ? { profile: { pendingCheckIds: ["tasks-status-payload-shape"] } }
          : {}),
        discovery: { wire: "extension", toolCount: 1, taskCapableToolCount: 1 },
      }) as never;

    const free = scoreFromTasksResult(tasksResult(true));
    expect(free.advisories).toEqual([]);
    expect(free.score).toBe(100);

    const scored = scoreFromTasksResult(tasksResult(false));
    expect(scored.advisories).toEqual([
      { id: "tasks-readiness-failed-status-message", tier: "should" },
    ]);
    expect(scored.score).toBe(100);

    // Advice from a check the profile does not score yet is not listed, even
    // without `informational`: the same rule as a pending check's warnings.
    const pending = scoreFromTasksResult(tasksResult(false, true));
    expect(pending.advisories).toEqual([]);
  });

  function oauthResult(
    overrides: Partial<OAuthConformanceResult> = {},
  ): OAuthConformanceResult {
    return {
      passed: true,
      outcome: "passed",
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      serverUrl: "https://mcp.example.com/mcp",
      steps: [
        {
          step: "request_without_token",
          title: "Initial MCP Request",
          summary: "…",
          status: "passed",
          durationMs: 1,
          logs: [],
          httpAttempts: [],
        },
        {
          step: "oauth_token_format",
          title: "Token format",
          summary: "…",
          status: "skipped",
          skipReason: "could-not-run",
          durationMs: 0,
          logs: [],
          httpAttempts: [],
          error: { message: "verification never ran" },
        },
      ],
      summary: "",
      durationMs: 2,
      ...overrides,
    };
  }

  it("scores OAuth from the step evidence, not the suite's own verdict", () => {
    // The runner can currently stamp outcome "passed" over could-not-run
    // steps; the score must not inherit that. 1 passed + 1 unrun of 2
    // applicable → 1/2 = 50%, outcome incomplete.
    const score = scoreFromOAuthResult(oauthResult());

    expect(score.outcome).toBe("incomplete");
    expect(score.applicable).toBe(2);
    expect(score.couldNotRun).toBe(1);
    expect(score.score).toBe(50);
  });

  it("leaves the steps a caller unscores out of the counts and the verdict", () => {
    // The flow still ran every step; the unrun one is simply not graded.
    const score = scoreFromOAuthResult(oauthResult(), {
      unscoredCheckIds: ["oauth_token_format"],
    });

    expect(score.applicable).toBe(1);
    expect(score.couldNotRun).toBe(0);
    expect(score.pending).toBe(1);
    expect(score.score).toBe(100);
    expect(score.outcome).toBe("passed");
  });

  it("lists OAuth advice like protocol advice", () => {
    const score = scoreFromOAuthResult(
      oauthResult({
        readiness: [
          {
            id: "readiness-oauth-iss-advertised",
            title: "Authorization Response iss",
            severity: "warning",
            specStrength: "SHOULD",
            message: "…",
          },
        ],
      }),
      { unscoredCheckIds: ["oauth_token_format"] }
    );

    expect(score.advisories).toEqual([
      { id: "readiness-oauth-iss-advertised", tier: "should" },
    ]);
    expect(score.score).toBe(100);
  });

  it("counts the same advice once across an OAuth suite's flows", () => {
    // Every flow hits the same authorization server, so each reports it.
    const flow = scoreFromOAuthResult(
      oauthResult({
        readiness: [
          {
            id: "readiness-oauth-iss-advertised",
            title: "Authorization Response iss",
            severity: "warning",
            specStrength: "SHOULD",
            message: "…",
          },
        ],
      }),
      { unscoredCheckIds: ["oauth_token_format"] },
    );
    const pooled = pooledConformanceScore([flow, flow, flow]);

    expect(pooled.advisories).toHaveLength(1);
  });

  it("marks unscored OAuth steps pending in the report, with the same score", () => {
    const report = toConformanceReport(oauthResult(), {
      oauthUnscoredCheckIds: ["oauth_token_format"],
    });
    const cases = report.groups.flatMap((group) => group.cases);

    expect(cases.find((c) => c.id === "oauth_token_format")?.pending).toBe(
      true
    );
    expect(cases.find((c) => c.id === "request_without_token")?.pending).toBe(
      undefined
    );
    expect(report.score?.pending).toBe(1);
    expect(report.score?.score).toBe(100);
  });

  it("passes the report when its only failure is an unscored step", () => {
    const failing = oauthResult({
      passed: false,
      outcome: "failed",
      steps: [
        oauthResult().steps[0]!,
        {
          ...oauthResult().steps[1]!,
          status: "failed",
          skipReason: undefined,
          error: { message: "listing failed" },
        },
      ],
    });
    const report = toConformanceReport(failing, {
      oauthUnscoredCheckIds: ["oauth_token_format"],
    });

    expect(report.score?.outcome).toBe("passed");
    expect(report.outcome).toBe("passed");
    expect(report.passed).toBe(true);
    expect(report.groups[0]?.passed).toBe(true);
    // Without the exclusion it is the flow's own failure.
    expect(toConformanceReport(failing).outcome).toBe("failed");
  });

  it("keeps a suite report's passed and outcome in step with a not-applicable flow", () => {
    const failingOnlyUnscored = oauthResult({
      passed: false,
      outcome: "failed",
      steps: [
        oauthResult().steps[0]!,
        {
          ...oauthResult().steps[1]!,
          status: "failed",
          skipReason: undefined,
          error: { message: "listing failed" },
        },
      ],
    });
    const report = toConformanceReport(
      {
        name: "OAuth suite",
        serverUrl: "https://mcp.example.com/mcp",
        passed: false,
        summary: "…",
        durationMs: 2,
        results: [
          {
            ...oauthResult({ outcome: "not-applicable", passed: false }),
            label: "no auth",
          },
          { ...failingOnlyUnscored, label: "dcr" },
        ],
      },
      { oauthUnscoredCheckIds: ["oauth_token_format"] }
    );

    expect(report.outcome).toBe("passed");
    expect(report.passed).toBe(true);
  });

  it("still counts a flow step a caller tries to unscore", () => {
    // Only the listed post-flow checks can be left out; a broken flow step
    // is the flow's own failure.
    const failing = oauthResult({
      passed: false,
      outcome: "failed",
      steps: [
        { ...oauthResult().steps[0]!, status: "failed" },
        { ...oauthResult().steps[1]!, status: "passed", skipReason: undefined },
      ],
    });
    const options = { unscoredCheckIds: ["request_without_token"] };
    const report = toConformanceReport(failing, {
      oauthUnscoredCheckIds: options.unscoredCheckIds,
    });

    expect(scoreFromOAuthResult(failing, options).pending).toBe(0);
    expect(scoreFromOAuthResult(failing, options).outcome).toBe("failed");
    expect(report.outcome).toBe("failed");
    expect(
      report.groups[0]?.cases.find((c) => c.id === "request_without_token")
        ?.pending
    ).toBeUndefined();
  });

  it("counts unscored steps as pending on a not-applicable flow too", () => {
    const score = scoreFromOAuthResult(
      oauthResult({ outcome: "not-applicable" }),
      { unscoredCheckIds: ["oauth_token_format"] }
    );

    expect(score.score).toBeNull();
    expect(score.notApplicable).toBe(1);
    expect(score.pending).toBe(1);
    expect(score.outcome).toBe("passed");
  });

  it("returns a scoreless result for a server without auth — OPTIONAL costs nothing", () => {
    const score = scoreFromOAuthResult(
      oauthResult({ outcome: "not-applicable" }),
    );

    expect(score.score).toBeNull();
    expect(score.applicable).toBe(0);
    expect(score.notApplicable).toBe(2);
    expect(score.outcome).toBe("passed");
  });
});
