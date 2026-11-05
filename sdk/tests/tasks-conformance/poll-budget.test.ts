import { afterEach, expect, it, vi } from "vitest";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { TaskOperations } from "../../src/tasks-conformance/task-operations.js";
import { normalizeMCPTasksConformanceConfig } from "../../src/tasks-conformance/validation.js";

const delay = vi.hoisted(() => vi.fn());
vi.mock("node:timers/promises", () => ({ setTimeout: delay }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delay.mockReset();
});

it.each([
  { interval: 3_600_000, requestMs: 40, sleeps: [60] },
  { interval: 3_600_000, requestMs: 100, sleeps: [] },
  { interval: 30, requestMs: 10, sleeps: [30, 30, 10] },
  { interval: undefined, requestMs: 0, sleeps: [100] },
])(
  "caps polling sleeps to the remaining budget: %j",
  async ({ interval, requestMs, sleeps }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    delay.mockImplementation(async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
    });
    const manager = new MCPClientManager({}, { lazyConnect: true });
    const read = vi
      .spyOn(manager, "getTaskExt")
      .mockImplementation(async () => {
        vi.setSystemTime(Date.now() + requestMs);
        return {
          taskId: "task",
          status: "working",
          ttlMs: 60_000,
          createdAt: "2026-07-27T00:00:00Z",
          lastUpdatedAt: "2026-07-27T00:00:00Z",
          pollIntervalMs: interval,
        };
      });
    const operations = new TaskOperations(
      normalizeMCPTasksConformanceConfig({
        url: "https://example.test/mcp",
        pollTimeoutMs: 100,
      })
    );
    const result = await operations.pollToTerminal(
      manager,
      "server",
      "extension",
      "task"
    );
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual(sleeps);
    expect(Date.now()).toBe(100);
    expect(read).toHaveBeenCalledTimes(Math.max(1, sleeps.length));
    expect(result.task?.status).toBe("working");
  }
);
