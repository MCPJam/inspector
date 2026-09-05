import { describe, expect, it } from "vitest";
import { STAGE_ANALYZER_VERSION } from "@mcpjam/sdk/contract";
import type { EvalIteration } from "../types";
import { chainForQuickRunIteration } from "../simple-case/quick-run-chain";

const verifiedRows = [
  { stage: "connection", state: "passed" },
  { stage: "discovery", state: "passed" },
  { stage: "selection", state: "passed" },
  { stage: "call", state: "failed", reason: "argumentMismatch" },
  { stage: "response", state: "notReached", reason: "earlierStageFailed" },
  { stage: "userValue", state: "notReached", reason: "earlierStageFailed" },
] as const;

function iteration(metadata: Record<string, unknown>): EvalIteration {
  return {
    _id: "iter-1",
    testCaseId: "case-1",
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    iterationNumber: 1,
    status: "completed",
    result: "failed",
    actualToolCalls: [{ toolName: "search", arguments: {} }],
    tokensUsed: 10,
    testCaseSnapshot: {
      title: "T",
      query: "Q",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [{ toolName: "search", arguments: {} }],
    },
    metadata,
  };
}

describe("chainForQuickRunIteration", () => {
  it("assembles a verified chain from valid stageResults", () => {
    const chain = chainForQuickRunIteration(
      iteration({
        stageResults: verifiedRows,
        firstFailedStage: "call",
        failureCategory: "arguments",
        stageAnalyzerVersion: STAGE_ANALYZER_VERSION,
      }),
    );
    expect(chain.status).toBe("verified");
    if (chain.status === "verified") {
      expect(chain.firstFailedStage).toBe("call");
    }
  });

  it("assembles an unverified chain when the rows do not validate", () => {
    const chain = chainForQuickRunIteration(
      iteration({
        stageResults: [{ stage: "call", state: "failed" }],
        stageAnalyzerVersion: 7,
      }),
    );
    expect(chain.status).toBe("unverified");
  });

  it("assembles an absent chain for pre-D1 metadata", () => {
    const chain = chainForQuickRunIteration(iteration({ turnCount: 1 }));
    expect(chain.status).toBe("absent");
  });
});
