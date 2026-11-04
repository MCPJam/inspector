import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMissingInputCheck,
  taskGroupFailure,
  type MCPTasksCheckId,
} from "@mcpjam/sdk/browser";
import { readStoredProbes, tasksRunOptions } from "../use-conformance-probes";
const run = vi.hoisted(() => vi.fn());
vi.mock("@/lib/apis/mcp-conformance-api", () => ({ runTasksConformance: run }));
import { runTaskConformanceGroups } from "../run-task-conformance-groups";
function passed(ids: MCPTasksCheckId[]) {
  const result = taskGroupFailure(ids, "", "fixture");
  result.checks = result.checks.map((check) => ({
    ...check,
    status: "passed",
    skipReason: undefined,
    error: undefined,
  }));
  return { success: true, result };
}
beforeEach(() => {
  run.mockReset();
});
describe("Inspector Tasks group requests", () => {
  it.each(["", " \t "])(
    "reports a saved blank override %j without inheriting or losing other checks",
    async (toolName) => {
      const saved = {
        tasksProbe: { toolName: "suite-tool" },
        tasksOverrides: {
          "tasks-update-ack-shape": {
            toolName,
            inputResponses: { answer: true },
          },
        },
      };
      window.localStorage.setItem(
        "mcpjam.conformance.probes.v1:blank-test",
        JSON.stringify(saved),
      );
      const options = tasksRunOptions(readStoredProbes("blank-test"), {
        tasks: ["tasks-update-ack-shape", "tasks-ttl-shape"],
      });
      run.mockResolvedValue(passed(["tasks-ttl-shape"]));
      const result = await runTaskConformanceGroups(
        "blank-test",
        options,
        () => true,
      );
      expect(run).toHaveBeenCalledExactlyOnceWith("blank-test", {
        checkIds: ["tasks-ttl-shape"],
        readinessIds: undefined,
        toolName: "suite-tool",
      });
      expect(result?.checks[0]).toMatchObject({
        id: "tasks-update-ack-shape",
        status: "skipped",
        skipReason: "could-not-run",
      });
      expect(result?.checks.filter(isMissingInputCheck)).toHaveLength(1);
      expect(result?.checks[1]?.status).toBe("passed");
      expect(result?.outcome).toBe("incomplete");
      expect(readStoredProbes("blank-test")).toEqual(saved);
    },
  );
  it("makes no requests when every selected check has an empty custom tool", async () => {
    const result = await runTaskConformanceGroups(
      "server",
      {
        toolName: "suite-tool",
        checkIds: ["tasks-inline-result", "tasks-cancel-ack-shape"],
        checkOverrides: {
          "tasks-inline-result": { toolName: "" },
          "tasks-cancel-ack-shape": { toolName: " " },
        },
      },
      () => true,
    );
    expect(run).not.toHaveBeenCalled();
    expect(result?.checks).toHaveLength(2);
    expect(result?.checks.every(isMissingInputCheck)).toBe(true);
    expect(result?.outcome).toBe("incomplete");
  });
  it("keeps valid checks running with the default all-checks selection", async () => {
    run.mockImplementation(async (_server, group) => passed(group.checkIds));
    const result = await runTaskConformanceGroups(
      "server",
      {
        toolName: "suite-tool",
        checkOverrides: { "tasks-inline-result": { toolName: "" } },
      },
      () => true,
    );
    expect(run).toHaveBeenCalled();
    expect(
      run.mock.calls.every(
        ([, group]) => !group.checkIds.includes("tasks-inline-result"),
      ),
    ).toBe(true);
    expect(
      result?.checks.find((check) => check.id === "tasks-inline-result"),
    ).toMatchObject({ details: { missingInput: "tasksProbe" } });
  });
  it("excludes an unselected blank override from execution", async () => {
    run.mockResolvedValue(passed(["tasks-ttl-shape"]));
    const result = await runTaskConformanceGroups(
      "server",
      tasksRunOptions(
        {
          tasksProbe: { toolName: "suite-tool" },
          tasksOverrides: { "tasks-inline-result": { toolName: "" } },
        },
        { tasks: ["tasks-ttl-shape"] },
      ),
      () => true,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result?.checks).toHaveLength(1);
    expect(result?.outcome).toBe("passed");
  });
  it("sends groups sequentially and retains passing checks after a request timeout", async () => {
    let finish: (value: ReturnType<typeof passed>) => void = () => {
      throw new Error("Request not started");
    };
    run
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("Hosted request timed out"));
    const promise = runTaskConformanceGroups(
      "server",
      {
        toolName: "default",
        checkIds: ["tasks-inline-result", "tasks-ttl-shape"],
        checkOverrides: { "tasks-ttl-shape": { toolName: "other" } },
      },
      () => true,
    );
    expect(run).toHaveBeenCalledTimes(1);
    finish(passed(["tasks-inline-result"]));
    const result = await promise;
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1].toolName).toBe("other");
    expect(result?.checks.map((check) => check.status)).toEqual([
      "passed",
      "skipped",
    ]);
    expect(result?.outcome).toBe("incomplete");
    expect(result?.checks[1]?.details?.toolName).toBe("other");
  });
  it("stops scheduling requests when the server or run changes", async () => {
    let active = true;
    run.mockImplementationOnce(async () => {
      active = false;
      return passed(["tasks-inline-result"]);
    });
    const result = await runTaskConformanceGroups(
      "server",
      {
        toolName: "job",
        checkIds: ["tasks-inline-result", "tasks-cancel-ack-shape"],
      },
      () => active,
    );
    expect(result).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
