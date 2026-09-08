import { describe, expect, it } from "vitest";
import {
  STAGE_ANALYZER_VERSION,
  projectStageDerivation,
  type StageResultRow,
} from "../src/contract/index.js";

const rows: StageResultRow[] = [
  { stage: "connection", state: "passed" },
  { stage: "discovery", state: "passed" },
  { stage: "selection", state: "passed" },
  { stage: "call", state: "failed", reason: "argumentMismatch" },
  { stage: "response", state: "notReached", reason: "earlierStageFailed" },
  { stage: "userValue", state: "notReached", reason: "earlierStageFailed" },
];

describe("projectStageDerivation", () => {
  it("projects a validated derivation with an ahead version unchanged", () => {
    expect(
      projectStageDerivation({
        stageResults: rows,
        firstFailedStage: "call",
        failureCategory: "arguments",
        stageAnalyzerVersion: STAGE_ANALYZER_VERSION + 1,
        internalOnly: "drop me",
      })
    ).toEqual({
      stageResults: rows,
      firstFailedStage: "call",
      failureCategory: "arguments",
      stageAnalyzerVersion: STAGE_ANALYZER_VERSION + 1,
    });
  });

  it("quarantines invalid rows and keeps only an independently valid version", () => {
    expect(
      projectStageDerivation({
        stageResults: [{ stage: "call", state: "failed" }],
        firstFailedStage: "call",
        failureCategory: "arguments",
        stageAnalyzerVersion: 7,
      })
    ).toEqual({
      stageResultsUnverified: true,
      stageAnalyzerVersion: 7,
    });
    expect(
      projectStageDerivation({
        stageResults: [{ stage: "call", state: "failed" }],
        stageAnalyzerVersion: -1,
      })
    ).toEqual({ stageResultsUnverified: true });
  });

  it("omits pre-D1 metadata and does not project a version by itself", () => {
    expect(projectStageDerivation({ turnCount: 1 })).toEqual({});
    expect(projectStageDerivation({ stageAnalyzerVersion: 2 })).toEqual({});
    expect(projectStageDerivation(null)).toEqual({});
  });
});
