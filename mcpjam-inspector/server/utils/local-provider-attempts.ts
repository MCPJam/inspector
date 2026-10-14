/** Observe provider calls after admission, including retries and tool steps. */
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { LocalExecutionAttempt } from "./local-execution-record.js";

export function observeLocalProviderAttempts(
  model: LanguageModel,
  wireModelId: string,
  attempts: LocalExecutionAttempt[],
) {
  if (typeof model === "string")
    throw new Error("A provider attempt requires a model object.");
  const begin = () => {
    const attempt: LocalExecutionAttempt = {
      rail: "local",
      wireModelId,
      outcome: "error",
      code: "completion_not_observed",
      at: Date.now(),
    };
    attempts.push(attempt);
    return attempt;
  };
  return wrapLanguageModel({
    model,
    middleware: {
      async wrapGenerate({ doGenerate }) {
        const attempt = begin();
        try {
          const result = await doGenerate();
          if (result.finishReason.unified === "error") {
            attempt.code = "provider_error";
          } else {
            attempt.outcome = "ok";
            delete attempt.code;
          }
          return result;
        } catch (error) {
          attempt.code = "provider_error";
          throw error;
        }
      },
      async wrapStream({ doStream }) {
        const attempt = begin();
        try {
          const result = await doStream();
          let failed = false;
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  if (chunk.type === "error") {
                    failed = true;
                    attempt.code = "provider_error";
                  }
                  if (
                    chunk.type === "finish" &&
                    chunk.finishReason.unified === "error"
                  ) {
                    failed = true;
                    attempt.code = "provider_error";
                  }
                  if (chunk.type === "finish" && !failed) {
                    attempt.outcome = "ok";
                    delete attempt.code;
                  }
                  controller.enqueue(chunk);
                },
              }),
            ),
          };
        } catch (error) {
          attempt.code = "provider_error";
          throw error;
        }
      },
    },
  });
}
