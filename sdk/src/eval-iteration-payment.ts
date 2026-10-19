import { z } from "zod";
import { SdkError } from "./errors.js";
import {
  reportingRequest,
  ReportingHttpError,
} from "./eval-reporting-transport.js";
import type { EvalRunContext } from "./eval-run-start.js";

export class EvalBillingError extends SdkError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, code, { cause });
    this.name = "EvalBillingError";
  }
}
const receiptSchema = z.object({
  ok: z.literal(true),
  runStartId: z.string().uuid(),
  iterationKey: z.string().uuid(),
  paymentId: z.string().min(1),
  billableSteps: z.number().int().positive().safe(),
});
export async function payEvalIteration(
  context: EvalRunContext,
  request: { iterationKey: string; caseId: string; billableSteps: number },
  signal?: AbortSignal
): Promise<string> {
  const { connection } = context;
  const body = { runStartId: context.runStartId, ...request };
  const deadlineAt = Date.now() + 10_000;
  try {
    return await reportingRequest(
      {
        timeoutMs: 3000,
        operationTimeoutMs: 10_000,
        deadlineAt,
        retryDelaysMs: [100, 300],
        maxResponseBytes: 16_384,
        signal,
      },
      `${connection.baseUrl}/api/v1/projects/${encodeURIComponent(context.projectId)}/eval-ingest/pay-iteration`,
      { method: "POST", body: JSON.stringify(body) },
      (value) => {
        const receipt = receiptSchema.parse(value);
        if (
          receipt.runStartId !== context.runStartId ||
          receipt.iterationKey !== request.iterationKey ||
          receipt.billableSteps !== request.billableSteps
        ) {
          throw new EvalBillingError(
            "MCPJam returned a different iteration payment. Start a new eval run.",
            "INVALID_PAYMENT_RESPONSE"
          );
        }
        return receipt.paymentId;
      },
      (error) =>
        error.status >= 500 ||
        (error.status === 429 &&
          error.body.details === undefined &&
          (error.retryAfterMs ?? 0) < deadlineAt - Date.now()),
      undefined,
      async () => {
        const headers = new Headers(connection.auth.headers);
        headers.set("Content-Type", "application/json");
        headers.set(
          "Authorization",
          `Bearer ${await connection.auth.getAuth()}`
        );
        return { headers };
      }
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof EvalBillingError) throw error;
    if (error instanceof ReportingHttpError && error.status < 500) {
      const details = error.body.details;
      const reason =
        details &&
        typeof details === "object" &&
        "reason" in details &&
        typeof details.reason === "string"
          ? details.reason
          : typeof error.body.code === "string"
            ? error.body.code
            : "PLATFORM_FEE_REQUIRED";
      throw new EvalBillingError(
        typeof error.body.message === "string"
          ? error.body.message
          : "MCPJam refused this iteration payment. Check your credits and organization limits.",
        reason,
        error
      );
    }
    throw new EvalBillingError(
      "Platform billing is unavailable. Try again shortly.",
      "PLATFORM_FEE_UNAVAILABLE",
      error
    );
  }
}

export function validateBillableSteps(value = 1): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new EvalBillingError(
      "Set billableSteps to a positive whole number.",
      "INVALID_BILLABLE_STEPS"
    );
}

export function billingAttemptError(
  error: unknown,
  budget?: { assertWithinBudget(): void }
) {
  try {
    budget?.assertWithinBudget();
  } catch (violation) {
    return violation;
  }
  return error;
}
