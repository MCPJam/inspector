import { z } from "zod";
import { SdkError } from "./errors.js";
import {
  reportingRequest,
  ReportingHttpError,
} from "./eval-reporting-transport.js";

export const ADMISSION_OPERATION_TIMEOUT_MS = 10_000;
export const ADMISSION_REQUEST_TIMEOUT_MS = 3_000;
export const ADMISSION_RETRY_DELAYS_MS = [100, 300];
const receiptSchema = z.object({
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
    public readonly receipt?: AdmissionReceipt
  ) {
    super(message, code);
  }
}

export class EvalAdmissionClient {
  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      project?: string;
    }
  ) {
    if (!config.apiKey.trim())
      throw new EvalAdmissionError(
        "Since @mcpjam/sdk 10, local evals need an MCPJam account, even with your own model keys. Pass an MCPJam API key or set MCPJAM_API_KEY.",
        "CREDENTIALS_MISSING"
      );
  }
  admit(input: AdmitInput, signal?: AbortSignal): Promise<AdmissionReceipt> {
    return this.request("admit", input, signal);
  }
  ensureSteps(
    attemptId: string,
    target: number,
    signal?: AbortSignal
  ): Promise<AdmissionReceipt> {
    return this.request("ensure-steps", { attemptId, target }, signal);
  }
  private async request(
    operation: string,
    payload: object,
    signal?: AbortSignal
  ): Promise<AdmissionReceipt> {
    signal?.throwIfAborted();
    const url = new URL(
      `/api/v1/projects/${encodeURIComponent(
        this.config.project ?? "default"
      )}/eval-ingest/${operation}`,
      this.config.baseUrl
    );
    try {
      const receipt = await reportingRequest(
        {
          timeoutMs: ADMISSION_REQUEST_TIMEOUT_MS,
          operationTimeoutMs: ADMISSION_OPERATION_TIMEOUT_MS,
          retryDelaysMs: ADMISSION_RETRY_DELAYS_MS,
          maxResponseBytes: 16_384,
          signal,
        },
        url.toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(payload),
        },
        (body) => receiptSchema.parse(body),
        (error) => error.status === 429 || error.status >= 500
      );
      signal?.throwIfAborted();
      if (receipt.state !== "active")
        throw new EvalAdmissionError(
          "This run authorization has expired or closed. Start a new run.",
          "ADMISSION_CLOSED",
          undefined,
          receipt
        );
      return receipt;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof EvalAdmissionError) throw error;
      if (error instanceof ReportingHttpError) {
        const body = error.body;
        const details =
          body.details &&
          typeof body.details === "object" &&
          !Array.isArray(body.details)
            ? (body.details as Record<string, unknown>)
            : undefined;
        const code =
          error.status === 402
            ? "BILLING_REFUSED"
            : error.status === 426
            ? "CLIENT_UPGRADE_REQUIRED"
            : error.status === 409
            ? String(details?.code ?? "ADMISSION_CONFLICT")
            : error.status === 401
            ? "CREDENTIALS_MISSING"
            : error.status === 404
            ? "NOT_FOUND"
            : "PLATFORM_UNAVAILABLE";
        throw new EvalAdmissionError(
          typeof body.message === "string"
            ? body.message
            : "Could not confirm billing with MCPJam, so this eval did not run. Try again in a few minutes.",
          code,
          details
        );
      }
      throw new EvalAdmissionError(
        "Could not confirm billing with MCPJam, so this eval did not run. Try again in a few minutes.",
        "PLATFORM_UNAVAILABLE"
      );
    }
  }
}

/** Assign ordinals synchronously; serialize grants before permitting each prompt. */
export class AttemptStepGuard {
  private ordinal = 0;
  private granted: number;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly client: EvalAdmissionClient,
    private readonly receipt: AdmissionReceipt,
    private readonly signal?: AbortSignal
  ) {
    if (
      !receipt.attemptId ||
      receipt.grantedSteps === undefined ||
      receipt.state !== "active"
    ) {
      throw new EvalAdmissionError(
        "This attempt has no active authorization. Start a new run.",
        "ADMISSION_CONFLICT"
      );
    }
    this.granted = receipt.grantedSteps;
  }
  beforePrompt(): Promise<void> {
    const target = ++this.ordinal;
    this.pending = this.pending.then(async () => {
      this.signal?.throwIfAborted();
      if (target > this.granted) {
        const grant = await this.client.ensureSteps(
          this.receipt.attemptId!,
          target,
          this.signal
        );
        if (grant.grantedSteps === undefined || grant.grantedSteps < target) {
          throw new EvalAdmissionError(
            "Could not confirm coverage for this prompt. Start a new run.",
            "PLATFORM_UNAVAILABLE"
          );
        }
        this.granted = grant.grantedSteps;
      }
      this.signal?.throwIfAborted();
    });
    return this.pending;
  }
}
