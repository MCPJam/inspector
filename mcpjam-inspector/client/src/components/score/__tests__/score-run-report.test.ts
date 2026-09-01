import { describe, expect, it } from "vitest";
import { buildScoreRunSubmission } from "../score-run-report";

const SCORE = {
  score: 84,
  outcome: "passed",
  applicable: 10,
  passed: 8,
  failed: 1,
  couldNotRun: 1,
  notApplicable: 2,
  advisories: [],
} as const;

describe("score run report", () => {
  it("does not build an empty submission", () => {
    expect(
      buildScoreRunSubmission("https://mcp.acme.com/mcp", {} as any),
    ).toBeNull();
  });

  it("builds summaries only for suites that produced scores", () => {
    const protocolResult = { profile: { pendingCheckIds: [] } };
    const submission = buildScoreRunSubmission("https://mcp.acme.com/mcp", {
      pooledScore: SCORE,
      protocolScore: SCORE,
      appsScore: undefined,
      tasksScore: undefined,
      oauthScore: SCORE,
      protocol: { result: protocolResult },
      apps: { result: undefined },
      tasks: { result: undefined },
      oauth: { result: { success: true } },
    } as any);

    expect(submission).toMatchObject({
      serverUrl: "https://mcp.acme.com/mcp",
      summary: { score: 84, advisoryCount: 0 },
      suiteSummaries: [
        { suiteId: "protocol", score: 84 },
        { suiteId: "oauth", score: 84 },
      ],
      report: {
        protocol: protocolResult,
        oauth: { success: true },
      },
    });
  });
});
