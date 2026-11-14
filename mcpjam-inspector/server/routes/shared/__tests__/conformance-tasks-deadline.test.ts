import { afterEach, expect, it, vi } from "vitest";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@mcpjam/sdk", async (original) => ({
  ...(await original<typeof import("@mcpjam/sdk")>()),
  MCPTasksConformanceTest: class {
    constructor(private config: { signal?: AbortSignal }) {}
    run() {
      return run(this.config.signal);
    }
  },
}));
import { runTasksConformance } from "../conformance";

afterEach(() => vi.useRealTimers());
it("waits for task client cleanup after the total deadline aborts", async () => {
  vi.useFakeTimers();
  let cleaned = false;
  let settled = false;
  run.mockImplementation(
    (signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              cleaned = true;
              reject(signal.reason);
            }, 100);
          },
          { once: true },
        );
      }),
  );
  const pending = runTasksConformance({
    url: "https://fixture.test/mcp",
    runTimeoutSeconds: 1,
  });
  const rejected = expect(
    pending.finally(() => {
      settled = true;
    }),
  ).rejects.toThrow("Run timed out after 1 seconds");
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toBe(false);
  expect(cleaned).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(cleaned).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
