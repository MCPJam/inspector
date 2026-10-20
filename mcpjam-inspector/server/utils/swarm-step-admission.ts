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
    super("Swarm model step is waiting for spending admission");
  }
}

export async function withSwarmStepAdmissionRetry(
  request: () => Promise<Response>,
  options: {
    sourceType?: string;
    stepIndex: number;
    budget: AdmissionWaitBudget;
    signal?: AbortSignal;
  },
): Promise<Response> {
  // The session runner retries empty turns. After a tool ran, only the
  // refused model request may be replayed, never the turn's completed tools.
  if (options.sourceType !== "swarm" || options.stepIndex === 0) {
    return request();
  }
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
      throw new AdmissionResponseError(response, {
        code: "spending_reservation_busy",
        httpStatus: response.status,
        ...(typeof body.retryAfter === "number" &&
        Number.isFinite(body.retryAfter)
          ? { retryAfterMs: body.retryAfter }
          : {}),
      });
    }, options);
  } catch (error) {
    // Preserve the final refusal for the engine's normal error reporting.
    if (error instanceof AdmissionResponseError) return error.response;
    throw error;
  }
}
