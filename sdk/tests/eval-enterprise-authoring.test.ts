import { EvalTest } from "../src/EvalTest";
import { assertion } from "../src/evaluators/assertion";
import type { HostExecutor } from "../src/HostExecutor";
import type { Evaluator } from "../src/evaluators/types";

function executor() {
  const clone = vi.fn(() => ({ ...host, getPromptHistory: () => [] }));
  const host = {
    withOptions: clone,
    getPromptHistory: () => [],
    run: vi.fn(),
  } as unknown as HostExecutor;
  return { host, clone };
}
const base = { id: "enterprise-case", name: "enterprise" };
const custom = (id: string, evaluate: Evaluator["evaluate"]): Evaluator => ({
  definition: {
    scorerId: id,
    idSource: "explicit",
    scorerVersion: "1",
    implementationHash: "impl",
    deterministic: true,
    role: "gating",
    passThreshold: 1,
  },
  evaluate,
});

describe("enterprise canonical authoring", () => {
  it("preserves legacy assertion ordinals, definitions, and hashes for canonical and mixed authoring", async () => {
    const a = { type: "noToolErrors" as const };
    const b = { type: "toolNeverCalled" as const, toolName: "danger" };
    const legacy = new EvalTest({
      ...base,
      test: () => true,
      predicates: [a, b],
    });
    const canonical = new EvalTest({
      ...base,
      execute: async () => {},
      evaluators: { mode: "extend", list: [assertion(a), assertion(b)] },
    });
    const mixed = new EvalTest({
      ...base,
      execute: () => {},
      predicates: [a],
      evaluators: { mode: "extend", list: [assertion(b)] },
    });
    expect(canonical.getEvaluationConfigSnapshot()).toEqual(
      legacy.getEvaluationConfigSnapshot()
    );
    expect(mixed.getEvaluationConfigSnapshot()).toEqual(
      legacy.getEvaluationConfigSnapshot()
    );
    const result = await canonical.run(executor().host, { iterations: 1 });
    expect(result.successes).toBe(1);
    expect(result.iterationDetails[0].evaluatorResults).toHaveLength(4);
  });

  it("inherits, extends, and explicitly replaces suite defaults", () => {
    const defaults = [assertion({ type: "noToolErrors" })];
    const inherited = new EvalTest(
      { ...base, execute: () => {} },
      { evaluators: defaults }
    );
    const ignored = new EvalTest(
      {
        ...base,
        execute: () => {},
        evaluators: {
          mode: "inherit",
          list: [assertion({ type: "toolNeverCalled", toolName: "danger" })],
        },
      },
      { evaluators: defaults }
    );
    expect(ignored.getEvaluationConfigSnapshot()).toEqual(
      inherited.getEvaluationConfigSnapshot()
    );
    const replaced = new EvalTest(
      { ...base, execute: () => {}, evaluators: { mode: "replace", list: [] } },
      { evaluators: defaults }
    );
    expect(replaced.getEvaluationConfigSnapshot().definitions).toHaveLength(2);
    const extended = new EvalTest(
      {
        ...base,
        execute: () => {},
        predicates: [{ type: "toolNeverCalled", toolName: "danger" }],
        evaluators: { mode: "extend", list: [] },
      },
      { evaluators: defaults }
    );
    expect(
      extended
        .getEvaluationConfigSnapshot()
        .definitions.map((row) => row.scorerId)
    ).toEqual([
      "legacy:test",
      "tool-match",
      "predicate:noToolErrors#0",
      "predicate:toolNeverCalled#1",
    ]);
  });

  it("evaluates duplicate identical definitions only once and refuses conflicts/reserved IDs", async () => {
    const evaluate = vi.fn(() => ({ score: 1 }));
    const evaluator = custom("custom", evaluate);
    const test = new EvalTest({
      ...base,
      execute: () => {},
      evaluators: { mode: "extend", list: [evaluator, evaluator] },
    });
    await test.run(executor().host, { iterations: 1 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(
      () =>
        new EvalTest({
          ...base,
          execute: () => {},
          evaluators: {
            mode: "extend",
            list: [
              evaluator,
              {
                ...evaluator,
                definition: { ...evaluator.definition, passThreshold: 0.5 },
              },
            ],
          },
        })
    ).toThrow(/duplicate evaluator id/);
    expect(
      () =>
        new EvalTest({
          ...base,
          execute: () => {},
          evaluators: {
            mode: "extend",
            list: [custom("legacy:test", evaluate)],
          },
        })
    ).toThrow(/built-in/);
    expect(
      () => new EvalTest({ ...base, test: () => true, execute: () => {} })
    ).toThrow(/sets both/);
    expect(() => new EvalTest({ ...base })).toThrow(/must provide 'execute'/);
    expect(
      () => new EvalTest({ ...base, execute: () => {}, evaluators: [] as any })
    ).toThrow(/evaluators must/);
  });
});

describe("bounded enterprise execution", () => {
  it.each([
    { iterations: 0 },
    { iterations: NaN },
    { iterations: 1, retries: -1 },
    { iterations: 1, concurrency: 0 },
    { iterations: 1, timeoutMs: Infinity },
    { iterations: 1, evaluatorConcurrency: 1, scorerConcurrency: 1 },
  ])("rejects invalid controls before cloning: %o", async (options) => {
    const { host, clone } = executor();
    const test = new EvalTest({ ...base, execute: () => {} });
    await expect(test.run(host, options)).rejects.toThrow();
    expect(clone).not.toHaveBeenCalled();
  });

  it("cancels queued iterations without starting execution and bounds an uncooperative driver", async () => {
    const { host, clone } = executor();
    const controller = new AbortController();
    const execute = vi.fn(() => new Promise<void>(() => {}));
    const test = new EvalTest({ ...base, execute });
    const run = test.run(host, {
      iterations: 10,
      concurrency: 1,
      retries: 2,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await run;
    expect(clone).toHaveBeenCalledTimes(1);
    expect(result.successes).toBe(0);
    expect(
      result.iterationDetails.every((row) => row.status === "cancelled")
    ).toBe(true);
    expect(result.iterations).toBe(10);
  });

  it("does not execute any pre-cancelled work", async () => {
    const { host, clone } = executor();
    const test = new EvalTest({ ...base, execute: () => {} });
    const controller = new AbortController();
    controller.abort();
    const result = await test.run(host, {
      iterations: 3,
      signal: controller.signal,
    });
    expect(result.failures).toBe(3);
    expect(clone).not.toHaveBeenCalled();
  });

  it("bounds a hung evaluator with the run deadline and refuses a late passing result", async () => {
    let resolve!: (value: { score: number }) => void;
    const evaluate = vi.fn(
      () =>
        new Promise<{ score: number }>((done) => {
          resolve = done;
        })
    );
    const test = new EvalTest({
      ...base,
      execute: () => {},
      evaluators: { mode: "extend", list: [custom("hung", evaluate)] },
    });
    const result = await test.run(executor().host, {
      iterations: 1,
      runTimeoutMs: 20,
    });
    expect(result.failures).toBe(1);
    expect(result.iterationDetails[0].status).toBe("cancelled");
    expect(result.iterationDetails[0].scores?.at(-1)?.status).toBe("error");
    resolve({ score: 1 });
    await Promise.resolve();
    expect(result.failures).toBe(1);
  });

  it("retains computed outcomes when observers throw", async () => {
    const test = new EvalTest({ ...base, test: () => false });
    const result = await test.run(executor().host, {
      iterations: 2,
      onProgress: () => {
        throw new Error("observer");
      },
      onFailure: () => {
        throw new Error("observer");
      },
    });
    expect(result.failures).toBe(2);
    expect(result.observerErrors).toHaveLength(3);
    expect(
      result.iterationDetails.every((row) => row.status === "completed")
    ).toBe(true);
  });
  it("captures async observer rejections without losing the result", async () => {
    const test = new EvalTest({ ...base, test: () => false });
    const result = await test.run(executor().host, {
      iterations: 1,
      mcpjam: { enabled: false },
      onProgress: async () => {
        throw new Error("observer");
      },
      onFailure: async () => {
        throw new Error("observer");
      },
    });
    await Promise.resolve();
    expect(result.failures).toBe(1);
    expect(result.observerErrors).toHaveLength(2);
  });
  it("preserves local results but fails strict reporting without a key", async () => {
    const test = new EvalTest({ ...base, execute: () => {} });
    await expect(
      test.run(executor().host, {
        iterations: 1,
        mcpjam: { apiKey: "", strict: true },
      })
    ).rejects.toThrow(/requires an API key/);
    expect(test.getResults()?.successes).toBe(1);
    expect(test.getReportingReceipt()).toMatchObject({
      state: "failed",
      error: { code: "MISSING_API_KEY" },
    });
  });

  it("snapshots authored assertions and definitions against caller mutation", async () => {
    const rule = { type: "toolNeverCalled" as const, toolName: "original" };
    const test = new EvalTest({
      ...base,
      execute: () => {},
      predicates: [rule],
    });
    const snapshot = test.getEvaluationConfigSnapshot();
    rule.toolName = "mutated";
    const exported = test.getConfig();
    exported.predicates![0] = { type: "noToolErrors" };
    expect(test.getConfig().predicates).toEqual([
      { type: "toolNeverCalled", toolName: "original" },
    ]);
    expect(test.getEvaluationConfigSnapshot()).toEqual(snapshot);
    expect(
      (
        await test.run(executor().host, {
          iterations: 1,
          mcpjam: { enabled: false },
        })
      ).successes
    ).toBe(1);
  });
});
