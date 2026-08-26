/**
 * The conformance score: MUSTs own 95 points, advice owns 5, and the
 * denominator rules from `conformance-outcome.ts` keep the number honest.
 * Every property asserted here is one a caller will quote to a server author,
 * so each has a test: not-applicable costs nothing, could-not-run caps below
 * 100, advice can never breach the 95-point MUST floor, and 100 means
 * "everything applicable passed and nothing was left to advise".
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
  it("scores 100 only when every applicable check passed and no advice fired", () => {
    const clean = computeConformanceScore(passing(26));
    expect(clean.score).toBe(100);
    expect(clean.outcome).toBe("passed");

    const withAdvice = computeConformanceScore(passing(26), [
      { id: "readiness-metadata-quality", tier: "should" },
    ]);
    expect(withAdvice.score).toBe(98);
    expect(withAdvice.outcome).toBe("passed");
    expect(withAdvice.advicePointsLost).toBe(2);
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

  it("keeps could-not-run in the denominator, so an incomplete run cannot reach 100", () => {
    const score = computeConformanceScore([
      ...passing(25),
      check("unrun", "skipped", "could-not-run"),
    ]);

    expect(score.outcome).toBe("incomplete");
    expect(score.applicable).toBe(26);
    // 95 × 25/26 + 5 = 96.3 — but an incomplete run is barred from the
    // MUST-clean band, so it reads 94 at most.
    expect(score.score).toBe(94);
  });

  it("reserves the 95–100 band for MUST-clean, complete runs", () => {
    // With a large denominator one failure costs less than the 5-point advice
    // budget (95 × 199/200 + 5 = 99.5), which would rank a violating server
    // above a clean-but-advised one. The band cap prevents exactly that.
    const failedOne = computeConformanceScore([
      ...passing(199),
      check("failed-one", "failed"),
    ]);
    expect(failedOne.score).toBe(94);
    expect(failedOne.outcome).toBe("failed");

    const unrunOne = computeConformanceScore([
      ...passing(199),
      check("unrun-one", "skipped", "could-not-run"),
    ]);
    expect(unrunOne.score).toBe(94);

    // A MUST-clean run with advice stays in the band but below 100 — rounding
    // alone would have printed 100 here.
    const advisedOnly = computeConformanceScore(passing(200), [
      { id: "advice", tier: "may" },
    ]);
    expect(advisedOnly.score).toBe(99);
    expect(advisedOnly.outcome).toBe("passed");
  });

  it("keeps a MUST-clean server at or above 95 no matter how much advice fired", () => {
    const advisories = Array.from({ length: 40 }, (_, index) => ({
      id: `advice-${index + 1}`,
      tier: "should" as const,
    }));
    const score = computeConformanceScore(passing(10), advisories);

    // SEP-2484: SHOULD-level findings are warnings, not failures. The advice
    // deduction floors at the 5-point advice budget, so no volume of advice
    // can demote a MUST-clean server across SEP-1730's 80/100 tier lines.
    expect(score.score).toBe(95);
    expect(score.advicePointsLost).toBe(5);
    expect(score.outcome).toBe("passed");
  });

  it("weights SHOULD/RECOMMENDED advice at 2 points and MAY at 1", () => {
    const should = computeConformanceScore(passing(10), [
      { id: "a", tier: "should" },
    ]);
    const may = computeConformanceScore(passing(10), [{ id: "a", tier: "may" }]);

    expect(should.score).toBe(98);
    expect(may.score).toBe(99);
  });

  it("never ranks a violating server above a MUST-clean one", () => {
    // The ordering property the bands guarantee: any failed run scores below
    // the floor (95) of any MUST-clean run, whatever the denominators.
    const oneFailure = computeConformanceScore([
      ...passing(25),
      check("failed", "failed"),
    ]);
    const maxAdvice = computeConformanceScore(
      passing(26),
      Array.from({ length: 10 }, (_, index) => ({
        id: `advice-${index}`,
        tier: "should" as const,
      })),
    );

    expect(oneFailure.score).toBeLessThan(maxAdvice.score!);
    expect(maxAdvice.score).toBe(95);
    expect(oneFailure.score).toBe(94);
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
    // 95 × 3/4 + 5 = 76.25 → 76, under the band cap.
    expect(failed.score).toBe(76);
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
    // 95 × 30/39 + 5 = 78 — an average of suite scores (≈ (100+5)/2 = 52 or
    // a naive mean of 100 and 5) would say something different; summing is
    // what keeps the 0-for-9 OAuth run visible.
    expect(pooled.score).toBe(78);
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
  it("always shows the number, the denominator, and the version", () => {
    const line = describeConformanceScore(
      computeConformanceScore(
        [...passing(24), check("f1", "failed"), check("f2", "failed")],
        [{ id: "advice", tier: "should" }],
        "2025-11-25",
      ),
    );

    expect(line).toBe(
      "91/100 — 24/26 applicable checks passed, 2 failed, 1 advisory (−2) [2025-11-25]",
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
          id: "readiness-metadata-quality",
          title: "Metadata Quality",
          severity: "warning",
          specStrength: "SHOULD",
          message: "…",
        },
        {
          id: "readiness-parse-error-handling",
          title: "Parse Error Handling",
          severity: "warning",
          specStrength: "MAY",
          message: "…",
        },
      ],
      ...overrides,
    };
  }

  it("maps protocol readiness onto tiers by spec strength, RECOMMENDED folding into SHOULD", () => {
    const score = scoreFromProtocolResult(
      protocolResult({
        readiness: [
          {
            id: "readiness-oauth-iss-advertised",
            title: "iss",
            severity: "warning",
            specStrength: "RECOMMENDED",
            message: "…",
          },
        ],
      }),
    );

    expect(score.advisories).toEqual([
      { id: "readiness-oauth-iss-advertised", tier: "should" },
    ]);
    expect(score.score).toBe(98);
    expect(score.protocolVersion).toBe("2025-11-25");
  });

  it("scores protocol checks with the readiness deduction applied", () => {
    const score = scoreFromProtocolResult(protocolResult());
    // 1/1 applicable passed; SHOULD (−2) + MAY (−1) advice → 97.
    expect(score.score).toBe(97);
    expect(score.notApplicable).toBe(1);
  });

  /**
   * Advice about behavior the spec EXPLICITLY PERMITS — a MAY the server is
   * entitled to take, or a non-normative example — is reported and must not
   * cost points. `readiness.ts` says as much in prose about the
   * protocol-version header ("reported and never scored"); before this the
   * scoring path deducted anyway, so a legacy-tolerant server lost SHOULD
   * points for doing something streamable-http.mdx allows in as many words.
   */
  it("reports informational advice without deducting for it", () => {
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
            id: "readiness-resource-error-echoes-uri",
            title: "Resource Errors Name Their URI",
            severity: "warning",
            specStrength: "MAY",
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
    expect(apps.score).toBe(98);

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
          step: "verify_list_tools",
          title: "List Tools",
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
    // applicable → 95 × 1/2 + 5 = 52.5 → 53, outcome incomplete.
    const score = scoreFromOAuthResult(oauthResult());

    expect(score.outcome).toBe("incomplete");
    expect(score.applicable).toBe(2);
    expect(score.couldNotRun).toBe(1);
    expect(score.score).toBe(53);
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
