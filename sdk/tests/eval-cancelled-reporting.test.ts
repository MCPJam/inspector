const capture = vi.hoisted(() =>
  vi.fn(async (input: any) => ({
    receipt: {
      schemaVersion: 1,
      state: "persisted",
      acceptedIterations: input.results.length,
      acknowledgedIterations: input.results.length,
      pendingIterations: 0,
    },
  }))
);
vi.mock("../src/eval-reporting-receipt.js", async (original) => ({
  ...(await original<typeof import("../src/eval-reporting-receipt.js")>()),
  captureEvalReporting: capture,
}));
import { EvalTest } from "../src/EvalTest";
import { EvalSuite } from "../src/EvalSuite";
import type { HostExecutor } from "../src/HostExecutor";
const executor = {
  withOptions: () => executor,
  getPromptHistory: () => [],
} as unknown as HostExecutor;

describe("execution cancellation preserves reporting", () => {
  beforeEach(() => {
    capture.mockClear();
  });
  it("persists every planned cancelled suite iteration with an independent transport signal", async () => {
    const execution = new AbortController();
    const transport = new AbortController();
    const suite = new EvalSuite({
      name: "cancelled",
      mcpjam: {
        apiKey: "test-key",
        ci: {},
        transport: { signal: transport.signal },
      },
    });
    const run = vi.fn(() => execution.abort());
    suite.add(new EvalTest({ id: "first", name: "first", execute: run }));
    suite.add(new EvalTest({ id: "second", name: "second", execute: run }));
    const result = await suite.run(executor, {
      iterations: 2,
      concurrency: 1,
      signal: execution.signal,
    });
    expect(result.aggregate.iterations).toBe(4);
    expect(result.aggregate.successes).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    const input = capture.mock.calls[0][0];
    expect(input.expectedIterations).toBe(4);
    expect(input.results).toHaveLength(4);
    expect(input.results.every((row: any) => row.passed === false)).toBe(true);
    expect(input.transport.signal).toBe(transport.signal);
    expect(input.transport.signal.aborted).toBe(false);
  });
  it("does not forward an aborted execution signal into single-case reporting", async () => {
    const execution = new AbortController();
    const test = new EvalTest({
      id: "cancelled",
      name: "cancelled",
      execute: () => execution.abort(),
    });
    const result = await test.run(executor, {
      iterations: 2,
      concurrency: 1,
      signal: execution.signal,
      mcpjam: { apiKey: "test-key", ci: {} },
    });
    expect(result.successes).toBe(0);
    expect(capture.mock.calls[0][0].transport.signal).toBeUndefined();
    expect(capture.mock.calls[0][0].expectedIterations).toBe(2);
  });
});
