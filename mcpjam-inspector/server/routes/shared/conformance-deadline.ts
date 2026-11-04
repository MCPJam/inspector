import { z } from "zod";

export const conformanceDeadlineFields = {
  runTimeoutSeconds: z.number().int().min(1).max(300).optional(),
  remainingRunTimeoutMs: z.number().int().positive().max(300_000).optional(),
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
  const timeoutMs =
    input.runTimeoutSeconds === undefined
      ? undefined
      : Math.min(
          input.runTimeoutSeconds * 1_000,
          input.remainingRunTimeoutMs ?? input.runTimeoutSeconds * 1_000,
        );
  const error = new Error(
    `Run timed out after ${input.runTimeoutSeconds} seconds`,
  );
  const remaining =
    timeoutMs === undefined
      ? undefined
      : timeoutMs - (Date.now() - (input.requestStartedAt ?? Date.now()));
  if (remaining !== undefined && remaining <= 0) controller.abort(error);
  const timer =
    remaining === undefined || remaining <= 0
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
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(deadline.signal.reason);
    deadline.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    deadline.signal.throwIfAborted();
    return await Promise.race([aborted, work(deadline.signal)]);
  } finally {
    deadline.signal.removeEventListener("abort", onAbort);
    deadline.dispose();
  }
}
