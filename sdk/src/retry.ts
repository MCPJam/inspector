import { isMethodUnavailableError } from "./mcp-client-manager/error-utils.js";
import { isAuthError } from "./mcp-client-manager/errors.js";

export interface RetryPolicy {
  retries: number;
  retryDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  retries: 0,
  retryDelayMs: 3_000,
};

export interface RetryExecutionOptions<T> {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  operation: (attempt: number) => Promise<T>;
  shouldRetryError?: (error: unknown, attempt: number) => boolean;
  shouldRetryResult?: (result: T, attempt: number) => boolean;
  onRetry?: (input: {
    attempt: number;
    error?: unknown;
    result?: T;
  }) => Promise<void> | void;
}

const RETRYABLE_NODE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(
    reason == null ? "The operation was aborted." : String(reason)
  );
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal.reason);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(toAbortError(signal?.reason));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function extractHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  if (statusCode !== undefined) {
    return statusCode;
  }

  const numericCode =
    "code" in error && typeof error.code === "number" ? error.code : undefined;
  if (numericCode !== undefined) {
    return numericCode;
  }

  if (!(error instanceof Error)) {
    return undefined;
  }

  const match = error.message.match(/\b(?:http|status)[:\s]+(\d{3})\b/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractNodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  return "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function normalizeRetryPolicy(policy?: RetryPolicy): RetryPolicy {
  return {
    retries: Math.max(0, policy?.retries ?? DEFAULT_RETRY_POLICY.retries),
    retryDelayMs: Math.max(
      0,
      policy?.retryDelayMs ?? DEFAULT_RETRY_POLICY.retryDelayMs
    ),
  };
}

export function isRetryableTransientError(error: unknown): boolean {
  if (isAuthError(error).isAuth) {
    return false;
  }

  if (isMethodUnavailableError(error, "rpc")) {
    return false;
  }

  const statusCode = extractHttpStatusCode(error);
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) {
    return true;
  }
  if (statusCode === 501) {
    return false;
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return true;
  }

  const nodeCode = extractNodeErrorCode(error)?.toUpperCase();
  if (nodeCode && RETRYABLE_NODE_ERROR_CODES.has(nodeCode)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  if (error.name === "AbortError" || message.includes("aborted")) {
    return false;
  }

  return [
    "connection reset",
    "connection refused",
    "connection terminated",
    "connect timeout",
    "dns lookup",
    "econn",
    "eai_again",
    "enotfound",
    "etimedout",
    "fetch failed",
    "network error",
    "network request failed",
    "socket hang up",
    "timed out",
    "timeout",
    "temporarily unavailable",
  ].some((pattern) => message.includes(pattern));
}

export async function retryWithPolicy<T>({
  policy,
  signal,
  operation,
  shouldRetryError,
  shouldRetryResult,
  onRetry,
}: RetryExecutionOptions<T>): Promise<T> {
  const normalized = normalizeRetryPolicy(policy);

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);

    try {
      const result = await operation(attempt);
      const shouldRetry =
        attempt < normalized.retries &&
        (shouldRetryResult?.(result, attempt) ?? false);

      if (!shouldRetry) {
        return result;
      }

      await onRetry?.({ attempt, result });
      await delay(normalized.retryDelayMs, signal);
    } catch (error) {
      const shouldRetry =
        attempt < normalized.retries &&
        (shouldRetryError?.(error, attempt) ?? false);

      if (!shouldRetry) {
        throw error;
      }

      await onRetry?.({ attempt, error });
      await delay(normalized.retryDelayMs, signal);
    }
  }
}
