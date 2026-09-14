import { EvalTest } from "../src/EvalTest";
import {
  reportedDefinitions,
  captureReportedMeasurements,
} from "../src/eval-reported";
import type { EvalExecutionContext } from "../src/eval-reported";
import type { HostExecutor } from "../src/HostExecutor";

const host = {
  withOptions: () => host,
  getPromptHistory: () => [],
} as unknown as HostExecutor;
const base = {
  id: "reported-case",
  name: "reported",
  reported: [{ id: "quality", version: "1", passThreshold: 0.8 }],
};

describe("declared reported measurements", () => {
  it.each([
    [true, 1],
    [false, 0],
    [0.5, 0.5],
  ])("records %s as %s, advisory", async (value, expected) => {
    const test = new EvalTest({
      ...base,
      execute: (_host, ctx) => ctx.report("quality", value),
    });
    const result = await test.run(host, {
      iterations: 1,
      mcpjam: { enabled: false },
    });
    expect(result.successes).toBe(1);
    expect(result.iterationDetails[0].scores?.at(-1)).toMatchObject({
      status: "scored",
      value: expected,
    });
    expect(result.iterationDetails[0].evaluatorResults?.at(-1)).toMatchObject({
      score: expected,
    });
    expect(result.evaluationConfig?.definitions.at(-1)).toMatchObject({
      role: "advisory",
    });
  });

  it.each([NaN, Infinity, -1, 1.1])(
    "reports invalid %s as an error without clamping",
    async (value) => {
      const test = new EvalTest({
        ...base,
        execute: (_host, ctx) => ctx.report("quality", value),
      });
      const result = await test.run(host, {
        iterations: 1,
        mcpjam: { enabled: false },
      });
      expect(result.successes).toBe(1);
      expect(result.iterationDetails[0].scores?.at(-1)).toMatchObject({
        status: "error",
      });
      expect(result.iterationDetails[0].scores?.at(-1)?.value).toBeUndefined();
    }
  );

  it("marks missing as skipped and undeclared as a driver error", async () => {
    const missing = new EvalTest({ ...base, test: () => true });
    expect(
      (
        await missing.run(host, { iterations: 1, mcpjam: { enabled: false } })
      ).iterationDetails[0].scores?.at(-1)?.status
    ).toBe("skipped");
    const unknown = new EvalTest({
      ...base,
      execute: (_host, ctx) => ctx.report("unknown", 1),
    });
    const result = await unknown.run(host, {
      iterations: 1,
      mcpjam: { enabled: false },
    });
    expect(result.failures).toBe(1);
    expect(result.iterationDetails[0].error).toContain(
      "Undeclared reported measurement"
    );
  });

  it("keeps final attempt evidence only and closes old and completed contexts", async () => {
    let attempts = 0;
    const contexts: EvalExecutionContext[] = [];
    const test = new EvalTest({
      ...base,
      execute: (_host, ctx) => {
        contexts.push(ctx);
        attempts++;
        if (attempts === 1) {
          ctx.report("quality", 1);
          throw new Error("retry");
        }
        contexts[0].report("quality", 1);
        ctx.report("quality", true);
        ctx.report("quality", 0.4);
      },
    });
    const result = await test.run(host, {
      iterations: 1,
      retries: 1,
      mcpjam: { enabled: false },
    });
    contexts[1].report("quality", 1);
    expect(result.iterationDetails[0].reportedEvidence).toEqual([
      { id: "quality", value: 0.4, duplicates: 1, attempt: 1 },
    ]);
    expect(result.iterationDetails[0].scores?.at(-1)?.rationale).toContain(
      "duplicate"
    );
    expect(result.iterationDetails[0].scores?.at(-1)?.value).toBe(0.4);
  });

  it("retains reported evidence when the final driver throws", async () => {
    const test = new EvalTest({
      ...base,
      execute: (_host, ctx) => {
        ctx.report("quality", 0.2);
        throw new Error("failed");
      },
    });
    const result = await test.run(host, {
      iterations: 1,
      mcpjam: { enabled: false },
    });
    expect(result.failures).toBe(1);
    expect(result.iterationDetails[0].scores?.at(-1)?.value).toBe(0.2);
  });

  it("versions lookup identity and bounds declarations", () => {
    expect(reportedDefinitions(base.reported)[0].implementationHash).not.toBe(
      reportedDefinitions([{ ...base.reported[0], version: "2" }])[0]
        .implementationHash
    );
    expect(() =>
      reportedDefinitions([...base.reported, ...base.reported])
    ).toThrow(/Duplicate/);
    const controller = new AbortController();
    const capture = captureReportedMeasurements(
      base.reported,
      controller.signal,
      0
    );
    controller.abort();
    capture.context.report("quality", 1);
    expect(capture.close()).toEqual([]);
  });
});
