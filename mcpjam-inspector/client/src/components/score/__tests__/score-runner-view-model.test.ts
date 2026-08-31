import { describe, expect, it } from "vitest";
import {
  isScoreRunnerBusy,
  SCORE_PREVIEW_DIMENSIONS,
  scoreRunnerBusyLabel,
  scoreRunnerHeadline,
  scoreRunnerLead,
} from "../score-runner-view-model";

describe("score runner view model", () => {
  it("labels busy phases without inventing a finished score", () => {
    expect(scoreRunnerBusyLabel("preparing")).toBe("Preparing…");
    expect(scoreRunnerBusyLabel("running")).toBe("Scanning…");
    expect(scoreRunnerBusyLabel("saving")).toBe("Saving…");
    expect(scoreRunnerBusyLabel("run-complete")).toBe("Saving…");
    expect(scoreRunnerBusyLabel("form")).toBeNull();
    expect(isScoreRunnerBusy("running")).toBe(true);
    expect(isScoreRunnerBusy("form")).toBe(false);
  });

  it("uses the Paper landing copy", () => {
    const copy = [scoreRunnerHeadline("form"), scoreRunnerLead("form")].join(
      " ",
    );
    expect(copy).toContain("Know where your MCP server stands.");
    expect(copy).toContain("We email a scorecard");
    expect(SCORE_PREVIEW_DIMENSIONS).toEqual([
      "Reliability",
      "Protocol",
      "Apps",
      "OAuth",
      "Security",
    ]);
  });
});
