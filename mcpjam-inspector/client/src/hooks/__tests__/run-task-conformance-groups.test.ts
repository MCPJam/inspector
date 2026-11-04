import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskGroupFailure, type MCPTasksCheckId } from "@mcpjam/sdk/browser";
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
beforeEach(() => run.mockReset());
describe("Inspector Tasks group requests", () => {
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
