import { describe, expect, it } from "vitest";
import type {
  EvalRunDecisionChain,
  EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";
import type { EvalIteration } from "../../evals/types";
import { affectedRowsById } from "../affected-iteration-rows";

const SELECTION_FAILED: EvalRunDecisionChain = {
  status: "verified",
  stages: [
    { stage: "connection", state: "passed" },
    { stage: "discovery", state: "passed" },
    { stage: "selection", state: "failed", reason: "missingToolCall" },
    { stage: "call", state: "notReached" },
    { stage: "response", state: "notReached" },
    { stage: "userValue", state: "notMeasured" },
  ],
  firstFailedStage: "selection",
  analyzerVersion: 8,
};

const iteration = { _id: "it_a", testCaseId: "tc_1" } as EvalIteration;
const diagnostic = {
  iterationId: "it_a",
  chain: SELECTION_FAILED,
} as EvalRunDecisionDiagnostic;

describe("affectedRowsById", () => {
  it("uses the diagnostic chain when the separate chain read has none", () => {
    const rows = affectedRowsById([iteration], null, new Map(), [diagnostic]);
    expect(rows.it_a.chain).toBe(SELECTION_FAILED);
  });

  it("prefers the diagnostic chain over the chain read", () => {
    const other = { status: "withheld" } as EvalRunDecisionChain;
    const rows = affectedRowsById(
      [iteration],
      null,
      new Map([["it_a", other]]),
      [diagnostic],
    );
    expect(rows.it_a.chain).toBe(SELECTION_FAILED);
  });

  it("keeps the diagnostic chain when the iteration metadata did not load", () => {
    const rows = affectedRowsById([], null, undefined, [diagnostic]);
    expect(rows.it_a.chain).toBe(SELECTION_FAILED);
    expect(rows.it_a.canOpen).toBe(false);
  });
});
