import { describe, it, expect } from "vitest";
import {
  planTasksConformance,
  validateTaskOverrides,
} from "../../src/tasks-conformance/plan.js";
import {
  mergeTasksConformanceResults,
  taskGroupFailure,
} from "../../src/tasks-conformance/report.js";
import { MCP_TASKS_TOOL_CHECK_IDS } from "../../src/tasks-conformance/types.js";

describe("Tasks execution plans", () => {
  it.each([undefined, {}])(
    "shares the update observation without answers %j",
    (inputResponses) => {
      const groups = planTasksConformance({
        toolName: "job",
        inputResponses,
        checkIds: ["tasks-inline-result", "tasks-update-ack-shape"],
      });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.checkIds).toEqual([
        "tasks-inline-result",
        "tasks-update-ack-shape",
      ]);
      expect(groups[0]).not.toHaveProperty("inputResponses");
    }
  );

  it("preserves the protocol pin across separate requests", () => {
    const groups = planTasksConformance({
      protocolVersion: "2026-07-28",
      toolName: "job",
      checkIds: ["tasks-inline-result", "tasks-cancel-ack-shape"],
    });
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.protocolVersion === "2026-07-28")).toBe(true);
  });
  it("shares equivalent arguments but replaces, rather than merges, an override", () => {
    const groups = planTasksConformance({
      toolName: "job",
      toolArguments: { a: 1, b: 2 },
      checkIds: [
        "tasks-ttl-shape",
        "tasks-inline-result",
        "tasks-status-payload-shape",
      ],
      checkOverrides: {
        "tasks-inline-result": {
          toolName: "job",
          toolArguments: { b: 2, a: 1 },
        },
        "tasks-status-payload-shape": { toolName: "job" },
      },
    });
    expect(groups).toHaveLength(2);
    expect(groups[0]?.checkIds).toEqual([
      "tasks-ttl-shape",
      "tasks-inline-result",
    ]);
    expect(groups[1]?.toolArguments).toBeUndefined();
  });
  it("isolates each mutating flow and shares the two undeclared capability checks", () => {
    const groups = planTasksConformance({
      toolName: "job",
      inputResponses: { answer: true },
      checkIds: [...MCP_TASKS_TOOL_CHECK_IDS],
    });
    expect(groups).toHaveLength(5);
    expect(
      groups.find((g) =>
        g.checkIds.includes("tasks-undeclared-capability-rejected")
      )?.checkIds
    ).toEqual([
      "tasks-undeclared-capability-rejected",
      "tasks-undeclared-capability-names-requirements",
    ]);
    expect(groups.filter((g) => g.inputResponses)).toHaveLength(1);
    expect(groups.find((g) => g.inputResponses)?.checkIds).toEqual([
      "tasks-update-ack-shape",
    ]);
  });
  it("does not send tool inputs for task-free selections or unselected overrides", () => {
    expect(
      planTasksConformance({
        toolName: "job",
        inputResponses: { a: 1 },
        checkOverrides: { "tasks-inline-result": { toolName: "unused" } },
        checkIds: ["tasks-wire-resolvable", "tasks-invalid-task-id-rejected"],
      })
    ).toEqual([
      {
        checkIds: ["tasks-wire-resolvable", "tasks-invalid-task-id-rejected"],
        readinessIds: undefined,
      },
    ]);
  });
  it("does not split a planned request again just to check declaration hygiene", () => {
    const groups = planTasksConformance({
      toolName: "job",
      checkIds: ["tasks-inline-result", "tasks-declaration-hygiene"],
    });
    expect(groups).toHaveLength(1);
    expect(planTasksConformance(groups[0]!)).toEqual(groups);
  });
  it.each([
    null,
    [],
    { unknown: { toolName: "job" } },
    { "tasks-wire-resolvable": { toolName: "job" } },
    { "tasks-inline-result": { toolName: " " } },
    { "tasks-inline-result": { toolName: "job", toolArguments: [] } },
  ])("rejects invalid override settings %j", (value) => {
    expect(() => validateTaskOverrides(value)).toThrow();
  });
});
describe("group report aggregation", () => {
  it("preserves completed results when another group times out and grades each check once", () => {
    const first = taskGroupFailure(
      ["tasks-ttl-shape", "tasks-declaration-hygiene"],
      "unused",
      "test"
    );
    first.checks = first.checks.map((check) => ({
      ...check,
      status: "passed",
      skipReason: undefined,
      error: undefined,
    }));
    const second = taskGroupFailure(
      ["tasks-inline-result", "tasks-declaration-hygiene"],
      "Request timed out",
      "test"
    );
    const result = mergeTasksConformanceResults(
      [first, second],
      ["tasks-ttl-shape", "tasks-inline-result", "tasks-declaration-hygiene"]
    );
    expect(result.outcome).toBe("incomplete");
    expect(result.checks).toHaveLength(3);
    expect(result.checks[0]?.status).toBe("passed");
    expect(result.checks[1]?.error?.message).toBe("Request timed out");
    expect(result.checks[2]?.skipReason).toBe("could-not-run");
  });
  it("omits singular discovery labels for multiple tools and tasks", () => {
    const first = taskGroupFailure(["tasks-ttl-shape"], "unavailable", "test");
    const second = taskGroupFailure(
      ["tasks-inline-result"],
      "unavailable",
      "test"
    );
    first.discovery = {
      ...first.discovery,
      probedTool: "one",
      createdTaskId: "1",
    };
    second.discovery = {
      ...second.discovery,
      probedTool: "two",
      createdTaskId: "2",
    };
    expect(
      mergeTasksConformanceResults([first, second]).discovery
    ).not.toHaveProperty("probedTool");
    expect(
      mergeTasksConformanceResults([first, second]).discovery
    ).not.toHaveProperty("createdTaskId");
  });
});
