import { describe, expect, it } from "vitest";
import { SCORE_PREVIEW_RESULT_TOKEN } from "../score-design-walkthrough";
import {
  isScorePreviewResultToken,
  scorePreviewRun,
} from "../score-preview-run";

describe("score preview run", () => {
  it("recognizes the reserved preview token", () => {
    expect(isScorePreviewResultToken(SCORE_PREVIEW_RESULT_TOKEN)).toBe(true);
    expect(isScorePreviewResultToken("tok_1")).toBe(false);
  });

  it("has every suite and a mix of check states", () => {
    const run = scorePreviewRun();
    expect(run.score).toBe(84);
    expect(run.serverUrl).toContain("monday.com");
    expect(run.suiteSummaries.map((suite) => suite.suiteId)).toEqual([
      "protocol",
      "apps",
      "tasks",
      "oauth",
    ]);
    expect(run.report.protocol).toBeTruthy();
    expect(run.report.oauth).toBeTruthy();
  });
});
