import { EvalTest } from "../src/EvalTest";
import { PromptResult } from "../src/PromptResult";
import {
  assertEvalCaptureWithinLimit,
  EvalCaptureLimitError,
  DEFAULT_MAX_CAPTURED_BYTES,
} from "../src/eval-capture-limit";
import type { HostExecutor } from "../src/HostExecutor";

const giant = "CAPTURE_CANARY_".repeat(2000);
function executor(): HostExecutor {
  const prompt = PromptResult.from({
    prompt: "query",
    messages: [{ role: "assistant", content: giant }],
    text: giant,
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 100, totalTokens: 110 },
    latency: { e2eMs: 1, llmMs: 1, mcpMs: 0 },
  });
  return {
    withOptions: () => ({ getPromptHistory: () => [prompt] }),
    getPromptHistory: () => [],
  } as unknown as HostExecutor;
}

describe("bounded retained iteration capture", () => {
  it.each([false, true])(
    "turns oversized capture into unavailable SDK evidence without retaining or retrying it (driver throws=%s)",
    async (throws) => {
      const evaluate = vi.fn(() => ({ kind: "scored" as const, score: 1 }));
      const execute = vi.fn(() => {
        if (throws) throw new Error("driver failed");
      });
      const test = new EvalTest({
        id: "capture",
        name: "capture",
        execute,
        evaluators: {
          mode: "extend",
          list: [
            {
              definition: {
                scorerId: "custom",
                idSource: "explicit",
                scorerVersion: "1",
                implementationHash: "hash",
                deterministic: true,
                role: "gating",
                passThreshold: 1,
              },
              evaluate,
            },
          ],
        },
      });
      const result = await test.run(executor(), {
        iterations: 1,
        retries: 3,
        maxCapturedBytes: 1024,
        mcpjam: { enabled: false },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(evaluate).not.toHaveBeenCalled();
      expect(result.captureCompleteness).toBe("partial");
      expect(result.successes).toBe(0);
      const row = result.iterationDetails[0];
      expect(row).toMatchObject({
        status: "failed",
        captureError: {
          code: "SDK_CAPTURE_LIMIT_EXCEEDED",
          maxCapturedBytes: 1024,
        },
        retryCount: 0,
        prompts: [],
      });
      expect(
        row.scores?.every(
          (score) => score.status === "error" && score.value === undefined
        )
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain("CAPTURE_CANARY");
      expect(row.error).toContain("SDK capture limit");
    }
  );

  it("validates controls before execution and allows bounded capture", async () => {
    const execute = vi.fn();
    const test = new EvalTest({ id: "small", name: "small", execute });
    await expect(
      test.run(executor(), { iterations: 1, maxCapturedBytes: 0 })
    ).rejects.toThrow(/maxCapturedBytes/);
    expect(execute).not.toHaveBeenCalled();
    const result = await test.run(executor(), {
      iterations: 1,
      maxCapturedBytes: DEFAULT_MAX_CAPTURED_BYTES,
      mcpjam: { enabled: false },
    });
    expect(result.successes).toBe(1);
    expect(result.captureCompleteness).toBeUndefined();
  });

  it("counts serialized Unicode, escapes and repeated evidence without building a whole JSON string", () => {
    const value = {
      message: 'x\n"é😀',
      nested: [null, true, { value: 3 }],
      same: { message: "value" },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(() => assertEvalCaptureWithinLimit(value, bytes)).not.toThrow();
    expect(() => assertEvalCaptureWithinLimit(value, bytes - 1)).toThrow(
      EvalCaptureLimitError
    );
  });
});
