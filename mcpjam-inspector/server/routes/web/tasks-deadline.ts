import { ErrorCode, WebRouteError } from "./errors.js";

/** The SDK settles only after cancellation and connection cleanup finish. */
export async function withTasksDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new WebRouteError(504, ErrorCode.TIMEOUT, message));
  }, deadlineMs);
  try {
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
