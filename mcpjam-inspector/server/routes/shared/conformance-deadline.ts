import {
  DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS,
  MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS,
} from "../../../shared/conformance-timeout.js";
import { z } from "zod";

export const conformanceDeadlineFields = {
  runTimeoutSeconds: z.number().int().min(1).max(MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS).optional(),
  remainingRunTimeoutMs: z.number().int().positive().max(MAX_CONFORMANCE_RUN_TIMEOUT_SECONDS * 1_000).optional(),
};

export interface ConformanceDeadlineInput {
  runTimeoutSeconds?: number;
  remainingRunTimeoutMs?: number;
  signal?: AbortSignal;
  requestStartedAt?: number;
}

/** Each suite receives the remaining budget of the same browser-owned run. */
export function createConformanceDeadline(input: ConformanceDeadlineInput) {
  const controller = new AbortController();
  const seconds =
    input.runTimeoutSeconds ?? DEFAULT_CONFORMANCE_RUN_TIMEOUT_SECONDS;
  const timeoutMs = Math.min(
    seconds * 1_000,
    input.remainingRunTimeoutMs ?? seconds * 1_000,
  );
  const error = new Error(`Run timed out after ${seconds} seconds`);
  const remaining =
    timeoutMs - (Date.now() - (input.requestStartedAt ?? Date.now()));
  if (remaining <= 0) controller.abort(error);
  const timer =
    remaining <= 0
      ? undefined
      : setTimeout(() => controller.abort(error), remaining);
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;
  return {
    signal,
    cancel: (reason: Error) => controller.abort(reason),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function deadlineFetch(
  fetchFn: typeof fetch,
  signal: AbortSignal,
): typeof fetch {
  return (input, init) => {
    signal.throwIfAborted();
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchFn(input, {
      ...init,
      signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
    });
  };
}

export async function runWithinConformanceDeadline<T>(
  input: ConformanceDeadlineInput,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = createConformanceDeadline(input);
  try {
    return await runWithConformanceSignal(deadline.signal, work);
  } finally {
    deadline.dispose();
  }
}

/** Reuse an OAuth session's original deadline when continuing its work. */
export async function runWithConformanceSignal<T>(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([aborted, work(signal)]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
