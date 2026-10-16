import { z } from "zod";
import { SdkError, type SdkErrorOptions } from "./errors.js";
import { V1_ERROR_STATUS } from "./public-api/index.js";
import { ReportingHttpError } from "./eval-reporting-transport.js";

export const receiptSchema = z.object({
  executionId: z.string().min(1),
  state: z.enum(["active", "closed", "expired"]),
  expiresAt: z.number().finite(),
  iterationId: z.string().optional(),
  attemptId: z.string().optional(),
  grantedSteps: z.number().int().nonnegative().optional(),
  feeMode: z.enum(["off", "shadow", "enforce"]).optional(),
  rateCardId: z.string().optional(),
});
export type AdmissionReceipt = z.infer<typeof receiptSchema>;
export type AdmitInput = {
  executionKey: string;
  externalRunId: string;
  purpose: "eval" | "inference";
  iterationKey?: string;
  attemptIndex?: number;
  initialSteps?: number;
  planFingerprint?: string;
};
export class EvalAdmissionError extends SdkError {
  constructor(
    message: string,
    code: string,
    public readonly details?: Record<string, unknown>,
    public readonly receipt?: AdmissionReceipt,
    options?: SdkErrorOptions
  ) {
    super(message, code, options);
  }
}

function admissionErrorCode(
  status: number,
  body: Record<string, unknown>
): string {
  if (typeof body.code === "string") return body.code;
  return (
    Object.entries(V1_ERROR_STATUS).find(
      ([, value]) => value === status
    )?.[0] ?? "INTERNAL_ERROR"
  );
}

export function admissionError(error: unknown): EvalAdmissionError {
  if (error instanceof EvalAdmissionError) return error;
  if (error instanceof ReportingHttpError) {
    const body = error.body;
    const details =
      body.details &&
      typeof body.details === "object" &&
      !Array.isArray(body.details)
        ? (body.details as Record<string, unknown>)
        : undefined;
    return new EvalAdmissionError(
      typeof body.message === "string"
        ? body.message
        : "Could not confirm billing with MCPJam, so this eval did not run. Try again in a few minutes.",
      admissionErrorCode(error.status, body),
      details,
      undefined,
      { cause: error }
    );
  }
  return new EvalAdmissionError(
    "Could not confirm billing with MCPJam, so this eval did not run. Try again in a few minutes.",
    "PLATFORM_UNAVAILABLE",
    undefined,
    undefined,
    { cause: error }
  );
}
