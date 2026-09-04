import { describe, expect, it } from "vitest";
import { NO_TOOL_PATH_KEY } from "@mcpjam/sdk/contract";
import type { EvalIteration } from "../types";
import {
  toolsFromIteration,
  summarizeRoutes,
} from "../simple-case/route-rollup";

function iteration(id: string, tools: string[], createdAt = 1): EvalIteration {
  return {
    _id: id,
    testCaseId: "case-1",
    createdBy: "u1",
    createdAt,
    updatedAt: createdAt,
    iterationNumber: Number(id.replace(/\D/g, "") || 1),
    status: "completed",
    result: "passed",
    actualToolCalls: tools.map((toolName) => ({ toolName, arguments: {} })),
    metadata: { compareRunId: "cmp_latest" },
    tokensUsed: 1,
    testCaseSnapshot: {
      title: "T",
      query: "Q",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [],
    },
  };
}

describe("summarizeRoutes", () => {
  it("counts the same collapsed route across the latest batch", () => {
    const rollup = summarizeRoutes([
      iteration("1", ["search", "search", "get"], 10),
      iteration("2", ["search", "get"], 11),
      iteration("3", ["list"], 12),
    ]);
    expect(rollup.total).toBe(3);
    expect(rollup.routes[0]?.count).toBe(2);
    expect(rollup.routes[0]?.pathKey).toBe("search→get");
    expect(rollup.routes[1]?.pathKey).toBe("list");
  });

  it("keeps arguments on a regression adopt and drops them for capability", () => {
    const trial = iteration("9", ["search", "search", "get"]);
    trial.actualToolCalls = [
      { toolName: "search", arguments: { q: "a" } },
      { toolName: "search", arguments: { q: "b" } },
      { toolName: "get", arguments: { id: 1 } },
    ];
    expect(toolsFromIteration(trial, "capability")).toEqual([
      { toolName: "search", arguments: {} },
      { toolName: "get", arguments: {} },
    ]);
    expect(toolsFromIteration(trial, "regression")).toEqual([
      { toolName: "search", arguments: { q: "a" } },
      { toolName: "search", arguments: { q: "b" } },
      { toolName: "get", arguments: { id: 1 } },
    ]);
  });

  it("uses the no-tools sentinel when a trial called nothing", () => {
    const rollup = summarizeRoutes([
      iteration("1", [], 10),
      iteration("2", [], 11),
    ]);
    expect(rollup.routes[0]?.pathKey).toBe(NO_TOOL_PATH_KEY);
    expect(rollup.routes[0]?.count).toBe(2);
  });
});
