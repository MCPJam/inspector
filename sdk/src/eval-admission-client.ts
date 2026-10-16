import {
  admissionError,
  EvalAdmissionError,
  receiptSchema,
  type AdmissionReceipt,
  type AdmitInput,
} from "./eval-admission-contract.js";
import { reportingRequest } from "./eval-reporting-transport.js";

export const ADMISSION_OPERATION_TIMEOUT_MS = 10_000;
export const ADMISSION_REQUEST_TIMEOUT_MS = 3_000;
export const ADMISSION_RETRY_DELAYS_MS = [100, 300];
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
    const deadlineAt = Date.now() + ADMISSION_OPERATION_TIMEOUT_MS;
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
          deadlineAt,
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
        (error) =>
          (error.status === 429 &&
            (error.retryAfterMs ?? 0) < deadlineAt - Date.now()) ||
          error.status >= 500
      );
      signal?.throwIfAborted();
      if (receipt.state !== "active" || receipt.expiresAt <= Date.now())
        throw new EvalAdmissionError(
          "This run authorization has expired or closed. Start a new run.",
          "ADMISSION_CLOSED",
          undefined,
          receipt
        );
      return receipt;
    } catch (error) {
      signal?.throwIfAborted();
      throw admissionError(error);
    }
  }
}

/** Assign ordinals synchronously; serialize grants before permitting each prompt. */
export class AttemptStepGuard {
  private ordinal = 0;
  private granted: number;
  private expiresAt: number;
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
    this.expiresAt = receipt.expiresAt;
    this.requireActive();
    this.granted = receipt.grantedSteps;
  }
  beforePrompt(): Promise<void> {
    const target = ++this.ordinal;
    this.pending = this.pending.then(async () => {
      this.signal?.throwIfAborted();
      this.requireActive();
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
        this.expiresAt = grant.expiresAt;
      }
      this.signal?.throwIfAborted();
      this.requireActive();
    });
    return this.pending;
  }
  private requireActive(): void {
    if (Date.now() >= this.expiresAt) {
      throw new EvalAdmissionError(
        "This run authorization has expired or closed. Start a new run.",
        "ADMISSION_CLOSED",
        undefined,
        this.receipt
      );
    }
  }
}
