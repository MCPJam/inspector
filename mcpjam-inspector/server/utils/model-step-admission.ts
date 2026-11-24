import { safeParseJSON } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { isTransientSpendRefusal } from "../../shared/swarm-attempt-error.js";
import {
  withAdmissionRetry,
  type AdmissionWaitBudget,
  type SpendRefusal,
} from "../services/sessionSimulation/admission-retry.js";

const refusalBodySchema = z.object({
  code: z.string().optional(),
  refusalReason: z.string().optional(),
  isRetryable: z.boolean().optional(),
  retryAfter: z.unknown().optional(),
});

/**
 * Time a resent model step needs once its wait ends. A wait that would leave
 * less than this ends with the refusal instead, so the iteration reports why
 * it was refused rather than a turn timeout on a call aborted mid-flight.
 */
const MODEL_STEP_MARGIN_MS = 60_000;

class AdmissionResponseError extends Error {
  constructor(
    readonly response: Response,
    readonly refusal: SpendRefusal,
  ) {
    super("Model step is waiting for spending admission");
  }
}

async function readWaitRefusal(
  response: Response,
): Promise<SpendRefusal | undefined> {
  if (response.status !== 503 && response.status !== 429) return undefined;
  let responseText: string;
  try {
    responseText = await response.clone().text();
  } catch {
    // Inspection is optional; preserve the backend refusal for reporting.
    return undefined;
  }
  const parsed = await safeParseJSON({
    text: responseText,
    schema: refusalBodySchema,
  });
  if (!parsed.success || parsed.value.isRetryable === false) return undefined;
  const { code, refusalReason, retryAfter } = parsed.value;
  if (!isTransientSpendRefusal(code, refusalReason)) return undefined;
  return {
    code,
    refusalReason,
    httpStatus: response.status,
    ...(typeof retryAfter === "number" && Number.isFinite(retryAfter)
      ? { retryAfterMs: retryAfter }
      : {}),
  };
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
  // tools: the backend refuses at admission, before the step runs. A refusal
  // is replayed when it lifts on its own: a busy reservation, or credits held
  // by in-flight calls (`holds_committed`), which free up as those settle. The
  // swarm session runner already retries an empty turn, so swarms start here
  // at step 1; a hosted eval turn has no outer retry and either refusal would
  // fail the iteration, so evals retry from step 0.
  const retriesHere =
    options.sourceType === "eval" ||
    (options.sourceType === "swarm" && options.stepIndex > 0);
  if (!retriesHere) return request();
  let pendingRefusal: AdmissionResponseError | undefined;
  try {
    return await withAdmissionRetry(async () => {
      // The refused response is never returned once a resend follows, so
      // release its connection now instead of at garbage collection.
      await pendingRefusal?.response.body?.cancel();
      const response = await request();
      const refusal = await readWaitRefusal(response);
      if (!refusal) return response;
      pendingRefusal = new AdmissionResponseError(response, refusal);
      throw pendingRefusal;
    }, {
      ...options,
      onWait: (delayMs) => {
        // Keep the refusal on the normal reporting path rather than let an
        // admission wait exhaust the turn clock and silently discard its trace.
        if (
          pendingRefusal &&
          options.remainingTurnMs &&
          delayMs + MODEL_STEP_MARGIN_MS >= options.remainingTurnMs()
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
