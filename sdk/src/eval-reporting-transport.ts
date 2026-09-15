/** Shared bounded transport for ingestion and presigned artifact uploads. */
export interface ReportingTransportOptions {
  timeoutMs: number;
  retryDelaysMs: number[];
  operationTimeoutMs?: number;
  /** Optional caller-provided absolute ceiling, in addition to the per-request budget. */
  deadlineAt?: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxArtifactBytes?: number;
}

export class ReportingProtocolError extends Error {}
export class ReportingHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
    public readonly retryAfterMs?: number
  ) {
    super(`Reporting request failed with status ${status}`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function retryAfterMs(
  value: string | null | undefined,
  now = Date.now()
): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1000
    : NaN;
  const result = Number.isFinite(seconds) ? seconds : Date.parse(value) - now;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readBody(
  response: Response,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const length = Number(response.headers?.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes)
    throw new ReportingProtocolError(
      "Reporting response exceeds the configured byte limit"
    );
  let value: unknown;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes)
          throw new ReportingProtocolError(
            "Reporting response exceeds the configured byte limit"
          );
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      value = JSON.parse(new TextDecoder().decode(bytes));
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    // Support custom fetch implementations without a streaming body.
    value = await response.json();
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > maxBytes)
      throw new ReportingProtocolError(
        "Reporting response exceeds the configured byte limit"
      );
  }
  if (!record(value))
    throw new ReportingProtocolError(
      "Invalid reporting response: expected a JSON object"
    );
  return value;
}

export async function reportingRequest<T>(
  options: ReportingTransportOptions,
  url: string,
  init: RequestInit,
  validate: (body: Record<string, unknown>) => T,
  shouldRetryHttp: (error: ReportingHttpError) => boolean,
  onAttempt?: (attempt: number) => void
): Promise<T> {
  const configuredBudget = options.operationTimeoutMs ?? 60_000;
  const budget =
    options.deadlineAt === undefined
      ? configuredBudget
      : Math.min(configuredBudget, Math.ceil(options.deadlineAt - Date.now()));
  if (budget <= 0)
    throw new DOMException(
      "Reporting operation deadline exceeded",
      "TimeoutError"
    );
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  for (const [name, value] of Object.entries({
    timeoutMs: options.timeoutMs,
    operationTimeoutMs: budget,
    maxResponseBytes: maxBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
      throw new ReportingProtocolError(`Invalid reporting ${name}`);
  }
  if (
    options.retryDelaysMs.length > 10 ||
    options.retryDelaysMs.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 60_000
    )
  )
    throw new ReportingProtocolError("Invalid reporting retry delays");
  const operation = new AbortController();
  const cancel = () => operation.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const deadline = setTimeout(
    () =>
      operation.abort(
        new DOMException(
          "Reporting operation deadline exceeded",
          "TimeoutError"
        )
      ),
    budget
  );
  try {
    for (let attempt = 0; ; attempt++) {
      if (operation.signal.aborted) throw operation.signal.reason;
      onAttempt?.(attempt + 1);
      const controller = new AbortController();
      const cancelAttempt = () => controller.abort(operation.signal.reason);
      if (operation.signal.aborted) cancelAttempt();
      operation.signal.addEventListener("abort", cancelAttempt, { once: true });
      const timer = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              "Reporting request deadline exceeded",
              "TimeoutError"
            )
          ),
        options.timeoutMs
      );
      let retryDelay: number | undefined;
      try {
        return await abortable(
          (async () => {
            const response = await fetch(url, {
              ...init,
              signal: controller.signal,
            });
            let body: Record<string, unknown>;
            try {
              body = await readBody(response, maxBytes);
            } catch (error) {
              if (!response.ok)
                throw new ReportingHttpError(
                  response.status,
                  {},
                  retryAfterMs(response.headers?.get("retry-after"))
                );
              if (error instanceof ReportingProtocolError) throw error;
              throw new ReportingProtocolError(
                "Invalid reporting response: malformed JSON"
              );
            }
            if (!response.ok)
              throw new ReportingHttpError(
                response.status,
                body,
                retryAfterMs(response.headers?.get("retry-after"))
              );
            return validate(body);
          })(),
          controller.signal
        );
      } catch (error) {
        const retryable =
          error instanceof ReportingHttpError
            ? shouldRetryHttp(error)
            : error instanceof TypeError ||
              (error instanceof Error && error.name === "TimeoutError");
        if (
          operation.signal.aborted ||
          !retryable ||
          attempt >= options.retryDelaysMs.length
        )
          throw error;
        const base = options.retryDelaysMs[attempt];
        retryDelay =
          error instanceof ReportingHttpError &&
          error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : Math.max(
                0,
                base + Math.floor((Math.random() * 2 - 1) * base * 0.2)
              );
      } finally {
        clearTimeout(timer);
        controller.abort();
        operation.signal.removeEventListener("abort", cancelAttempt);
      }
      let backoff: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortable(
          new Promise<void>((resolve) => {
            backoff = setTimeout(resolve, Math.min(retryDelay ?? 0, budget));
          }),
          operation.signal
        );
      } finally {
        clearTimeout(backoff);
      }
    }
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", cancel);
  }
}
