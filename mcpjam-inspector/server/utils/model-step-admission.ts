import { safeParseJSON } from "@ai-sdk/provider-utils";
import { z } from "zod";
import {
  withAdmissionRetry,
  type AdmissionWaitBudget,
  type SpendRefusal,
} from "../services/sessionSimulation/admission-retry.js";

const busyResponseSchema = z.object({
  code: z.literal("spending_reservation_busy"),
  isRetryable: z.literal(true).optional(),
  retryAfter: z.unknown().optional(),
});

class AdmissionResponseError extends Error {
  constructor(
    readonly response: Response,
    readonly refusal: SpendRefusal,
  ) {
    super("Model step is waiting for spending admission");
  }
}

export async function withModelStepAdmissionRetry(
  request: () => Promise<Response>,
  options: {
    sourceType?: string;
    stepIndex: number;
    budget: AdmissionWaitBudget;
    signal?: AbortSignal;
    remainingTurnMs?: () => number;
  },
): Promise<Response> {
  // Only the refused model request is replayed, never the turn's completed
  // tools. The swarm session runner already retries an empty turn, so swarms
  // start here at step 1; a hosted eval turn has no outer retry and a busy
  // refusal would fail the iteration, so evals retry from step 0.
  const retriesHere =
    options.sourceType === "eval" ||
    (options.sourceType === "swarm" && options.stepIndex > 0);
  if (!retriesHere) return request();
  let pendingRefusal: AdmissionResponseError | undefined;
  try {
    return await withAdmissionRetry(async () => {
      const response = await request();
      if (response.status !== 503) return response;
      let responseText: string;
      try {
        responseText = await response.clone().text();
      } catch {
        // Inspection is optional; preserve the backend refusal for reporting.
        return response;
      }
      const parsed = await safeParseJSON({
        text: responseText,
        schema: busyResponseSchema,
      });
      if (!parsed.success) return response;
      const body = parsed.value;
      pendingRefusal = new AdmissionResponseError(response, {
        code: "spending_reservation_busy",
        httpStatus: response.status,
        ...(typeof body.retryAfter === "number" &&
        Number.isFinite(body.retryAfter)
          ? { retryAfterMs: body.retryAfter }
          : {}),
      });
      throw pendingRefusal;
    }, {
      ...options,
      onWait: (delayMs) => {
        // Keep the refusal on the normal reporting path rather than let an
        // admission wait exhaust the turn clock and silently discard its trace.
        if (
          pendingRefusal &&
          options.remainingTurnMs &&
          delayMs >= options.remainingTurnMs()
        ) {
          throw pendingRefusal;
        }
      },
    });
  } catch (error) {
    // Preserve the final refusal for the engine's normal error reporting.
    if (error instanceof AdmissionResponseError) return error.response;
    throw error;
  }
}
