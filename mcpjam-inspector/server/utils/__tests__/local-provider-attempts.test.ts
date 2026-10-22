import { expect, it } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { observeLocalProviderAttempts } from "../local-provider-attempts.js";
import type { LocalExecutionAttempt } from "../local-execution-record.js";
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
it("records an error finish as a failure for generate and stream", async () => {
  const attempts: LocalExecutionAttempt[] = [];
  const model = observeLocalProviderAttempts(
    new MockLanguageModelV3({
      doGenerate: {
        content: [],
        finishReason: { unified: "error", raw: "error" },
        usage,
        warnings: [],
      },
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "finish",
              finishReason: { unified: "error", raw: "error" },
              usage,
            },
          ],
        }),
      },
    }),
    "fixture",
    attempts,
  );
  await model.doGenerate({ prompt: [] });
  const { stream } = await model.doStream({ prompt: [] });
  for await (const chunk of stream) expect(chunk.type).toBe("finish");
  expect(attempts.map(({ outcome, code }) => ({ outcome, code }))).toEqual([
    { outcome: "error", code: "provider_error" },
    { outcome: "error", code: "provider_error" },
  ]);
});
