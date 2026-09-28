import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalSuite } from "../src/EvalSuite.js";
import { EvalTest } from "../src/EvalTest.js";
import { PromptResult } from "../src/PromptResult.js";
import type { HostExecutor } from "../src/HostExecutor.js";
import {
  iterationToEvalResult,
  iterationsToEvalResultInputs,
  suiteTestResultsToEvalResultInputs,
} from "../src/eval-result-mapping.js";
import {
  evaluateGates,
  gateInputFromRunResult,
  gateInputFromSuiteResult,
} from "../src/gates.js";
const executor = (prompts: PromptResult[] = []): HostExecutor =>
  ({
    withOptions: () => executor(prompts),
    getPromptHistory: () => prompts,
    resetPromptHistory: () => {},
  }) as unknown as HostExecutor;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("suite execution boundary regressions", () => {
  it("uses one deadline across sequential cases and retains cancelled planned work", async () => {
    vi.useFakeTimers();
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    const entered: string[] = [];
    for (const id of ["first", "second", "never-started"])
      suite.add(
        new EvalTest({
          id,
          name: id,
          execute: async () => {
            entered.push(id);
            await new Promise((resolve) => setTimeout(resolve, 60));
          },
        })
      );
    const pending = suite.run(executor(), { runTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(60);
    expect(entered).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(40);
    const result = await pending;
    expect(entered).toEqual(["first", "second"]);
    expect(result.aggregate.iterations).toBe(3);
    expect(result.tests.get("first")?.iterationDetails[0].status).toBe(
      "completed"
    );
    for (const id of ["second", "never-started"])
      expect(result.tests.get(id)?.iterationDetails[0]).toMatchObject({
        passed: false,
        status: "cancelled",
      });
  });
  it("rejects overlapping runs and case mutation, then releases the lock", async () => {
    const started = deferred();
    const finish = deferred();
    const execute = vi.fn(async () => {
      started.resolve();
      await finish.promise;
    });
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    suite.add(new EvalTest({ id: "one", name: "one", execute }));
    const pending = suite.run(executor());
    await started.promise;
    await expect(suite.run(executor())).rejects.toThrow(/already running/);
    expect(() =>
      suite.add(
        new EvalTest({ id: "two", name: "two", execute: async () => {} })
      )
    ).toThrow(/running/);
    expect(execute).toHaveBeenCalledTimes(1);
    finish.resolve();
    await pending;
    await expect(suite.run(executor(), { iterations: 0 })).rejects.toThrow(
      /iterations/
    );
    await suite.run(executor());
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("snapshots caller-owned matcher defaults before later cases execute", async () => {
    const matchOptions = { allowExtraTools: false };
    const started = deferred();
    const finish = deferred();
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      matchOptions,
      mcpjam: { enabled: false },
    });
    suite.add(
      new EvalTest({
        id: "first",
        name: "first",
        execute: async () => {
          started.resolve();
          await finish.promise;
        },
      })
    );
    const second = new EvalTest({
      id: "second",
      name: "second",
      execute: async () => {},
    });
    suite.add(second);
    const pending = suite.run(executor());
    await started.promise;
    matchOptions.allowExtraTools = true;
    finish.resolve();
    await pending;
    expect(second.getConfig().matchOptions).toEqual({ allowExtraTools: false });
  });
  it("omits unavailable capture from every upload adapter and refuses resource gates", async () => {
    const prompt = PromptResult.from({
      prompt: "query",
      messages: [{ role: "assistant", content: "large".repeat(1000) }],
      text: "large".repeat(1000),
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
    });
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    suite.add(
      new EvalTest({ id: "capture", name: "capture", execute: async () => {} })
    );
    const result = await suite.run(executor([prompt]), {
      maxCapturedBytes: 100,
    });
    const run = result.tests.get("capture")!;
    const row = run.iterationDetails[0];
    expect(row.captureError?.code).toBe("SDK_CAPTURE_LIMIT_EXCEEDED");
    const uploads = [
      iterationToEvalResult(row, 0, { caseTitle: "capture" }),
      ...iterationsToEvalResultInputs("capture", [row]),
      ...suiteTestResultsToEvalResultInputs(result.tests),
    ];
    expect(uploads).toHaveLength(3);
    for (const upload of uploads) {
      expect(upload.tokens).toBeUndefined();
      expect(upload.trace).toBeUndefined();
      expect(upload.actualToolCalls).toBeUndefined();
      expect(upload.metadata).toMatchObject({
        captureCompleteness: "unavailable",
      });
      expect(JSON.stringify(upload)).not.toContain("largelarge");
    }
    for (const input of [
      gateInputFromRunResult(run),
      gateInputFromSuiteResult(result),
    ]) {
      expect(input.totals?.tokens).toBeUndefined();
      expect(input.totals?.e2eP95Ms).toBeUndefined();
      const decision = evaluateGates(input, {
        maximumTotalTokens: 100,
        maximumCostUsd: 100,
      });
      expect(decision.verdicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            gate: "maximumTotalTokens",
            status: "non_gateable",
          }),
          expect.objectContaining({
            gate: "maximumCostUsd",
            status: "non_gateable",
          }),
        ])
      );
    }
  });
});

describe("suite signal compatibility", () => {
  const makeSuite = (execute = async () => {}) => {
    const suite = new EvalSuite({
      defaults: { iterations: 1 },
      mcpjam: { enabled: false },
    });
    suite.add(new EvalTest({ id: "one", name: "one", execute }));
    return suite;
  };
  it("works without AbortSignal.any and cleans up fallback listeners", async () => {
    vi.spyOn(AbortSignal, "any");
    Object.defineProperty(AbortSignal, "any", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const execute = vi.fn(async () => {});
    const suite = makeSuite(execute);
    await suite.run(executor(), { signal: caller.signal });
    await suite.run(executor(), { signal: caller.signal });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it("clears timers and unlocks after signal setup fails", async () => {
    vi.useFakeTimers();
    const any = vi.spyOn(AbortSignal, "any").mockImplementationOnce(() => {
      throw new Error("composition failed");
    });
    const suite = makeSuite();
    await expect(
      suite.run(executor(), {
        signal: new AbortController().signal,
        runTimeoutMs: 1000,
      })
    ).rejects.toThrow("composition failed");
    expect(vi.getTimerCount()).toBe(0);
    any.mockRestore();
    await suite.run(executor());
  });
  it("finishes active and queued cases after reporting is aborted", async () => {
    const reporting = new AbortController();
    const started = deferred();
    const finish = deferred();
    const suite = makeSuite(async () => {
      started.resolve();
      await finish.promise;
    });
    const second = vi.fn(async () => {});
    suite.add(new EvalTest({ id: "two", name: "two", execute: second }));
    const pending = suite.run(executor(), {
      mcpjam: { enabled: false, transport: { signal: reporting.signal } },
    });
    await started.promise;
    reporting.abort(new Error("stop uploads"));
    finish.resolve();
    const result = await pending;
    expect(second).toHaveBeenCalledTimes(1);
    for (const run of result.tests.values())
      expect(run.iterationDetails[0].status).toBe("completed");
  });
});
