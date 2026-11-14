/**
 * The measurement script's parts that need no network: what it refuses to
 * run without, how it splits the held-out cases into broker requests, and how
 * it scores answers at each threshold. The script itself only runs by hand.
 */

import { describe, expect, it } from "vitest";

import {
  loadHeldOutCases,
  measurementBatches,
  measurementItems,
  scoreMeasurement,
  type HeldOutCase,
} from "../../scripts/decision-scan-held-out.js";
import { measurementConfig } from "../../scripts/measure-decision-scan.js";
import { DIRECTORY_DECISION_LIMITS } from "../../src/directory-readiness/index.js";

const READY = {
  DECISION_SCAN_URL: "https://sample-deployment.convex.site/",
  DECISION_SCAN_SERVICE_TOKEN: "sample-service-token-0123456789",
  DECISION_SCAN_RUNS: "claude:run_a:job-a, openai:run_b:job-b",
};

describe("the measurement's configuration", () => {
  it("names every variable it is missing", () => {
    const config = measurementConfig({});
    expect(config.ok).toBe(false);
    const problems = config.ok ? [] : config.problems;
    expect(problems.join("\n")).toMatch(/DECISION_SCAN_URL/);
    expect(problems.join("\n")).toMatch(/DECISION_SCAN_SERVICE_TOKEN/);
    expect(problems.join("\n")).toMatch(/DECISION_SCAN_RUNS/);
  });

  it("refuses to run in CI or under the test runner", () => {
    for (const flag of [{ CI: "true" }, { VITEST: "true" }]) {
      const config = measurementConfig({ ...READY, ...flag });
      expect(config).toMatchObject({
        ok: false,
        problems: [expect.stringMatching(/not run in CI/)],
      });
    }
  });

  it("refuses a run it cannot place and an origin that is not HTTPS", () => {
    const config = measurementConfig({
      ...READY,
      DECISION_SCAN_URL: "http://sample-deployment.convex.site",
      DECISION_SCAN_RUNS: "muse:run_c:job-c",
    });
    expect(config.ok ? [] : config.problems).toHaveLength(2);
  });

  it("reads the origin and each leased run", () => {
    expect(measurementConfig(READY)).toEqual({
      ok: true,
      url: "https://sample-deployment.convex.site",
      token: READY.DECISION_SCAN_SERVICE_TOKEN,
      runs: [
        { directory: "claude", runId: "run_a", jobId: "job-a" },
        { directory: "openai", runId: "run_b", jobId: "job-b" },
      ],
    });
  });
});

describe("the requests", () => {
  it("ask the 180 held-out cases in 5 Claude and 3 ChatGPT requests within the per-run cap", () => {
    const batches = measurementBatches(measurementItems(loadHeldOutCases()));
    expect(
      batches.map(({ directory, items }) => [directory, items.length])
    ).toEqual([
      ["claude", 24],
      ["claude", 24],
      ["claude", 24],
      ["claude", 24],
      ["claude", 12],
      ["openai", 24],
      ["openai", 24],
      ["openai", 24],
    ]);
    for (const { directory, items } of batches) {
      expect(items.length).toBeLessThanOrEqual(
        DIRECTORY_DECISION_LIMITS.maxQuestionsPerRun
      );
      expect(items.every((item) => item.directory === directory)).toBe(true);
    }
  });
});

describe("scoring", () => {
  const DIRECTION = "claude.decision.cross-tool-direction";
  const heldOut = (
    id: string,
    expected: string,
    text: string
  ): HeldOutCase => ({
    id,
    question: DIRECTION,
    expected,
    tool: `tool_${id}`,
    siblings: ["get_item"],
    text,
  });
  const cases = [
    heldOut("v1", "direction", "Call get_item first."),
    // Unproposed: the rules miss a split phrasal verb, so it is asked whole.
    heldOut("v2", "direction", "Look the item up with get_item first."),
    heldOut("v3", "direction", "Call get_item first."),
    heldOut("b1", "reference", "Call get_item first."),
    heldOut("b2", "reference", "Returns the same fields as get_item."),
  ];
  const items = measurementItems(cases);
  const answer = (
    key: string,
    verdict: string,
    confidence: number,
    quote: string
  ) => ({
    questionId: DIRECTION,
    candidateKey: key,
    verdict,
    confidence,
    quote,
  });
  const [score] = scoreMeasurement(cases, items, [
    answer("v1", "direction", 0.75, "Call get_item first."),
    answer("v2", "direction", 0.9, "with get_item"),
    answer("b1", "direction", 0.65, "Call get_item"),
    // A quote the text does not hold is dropped, whatever the verdict.
    answer("b2", "reference", 0.95, "the same fields as get_order"),
  ]);

  it("tells the rules' proposals from the cases asked whole", () => {
    expect(items.map((m) => [m.caseId, m.proposed])).toEqual([
      ["v1", true],
      ["v2", false],
      ["v3", true],
      ["b1", true],
      ["b2", false],
    ]);
    expect(score).toMatchObject({
      questionId: DIRECTION,
      violations: 3,
      benign: 2,
      proposed: { violations: 2, benign: 1 },
      dropped: ["b2"],
      unanswered: ["v3"],
    });
  });

  it("counts a violation the rules never propose as missed, and an unanswered one as neither", () => {
    expect(score?.thresholds[0]).toEqual({
      threshold: 0.5,
      missed: ["v2"],
      falseAlarms: ["b1"],
      warned: [],
      modelMissed: [],
      modelFalseAlarms: ["b1"],
    });
  });

  it("turns a verdict below the threshold into a warning, never a pass", () => {
    expect(score?.thresholds[3]).toEqual({
      threshold: 0.8,
      missed: ["v2"],
      falseAlarms: [],
      warned: ["v1", "b1"],
      modelMissed: [],
      modelFalseAlarms: [],
    });
  });
});
