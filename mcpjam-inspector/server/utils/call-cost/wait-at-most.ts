import { logger } from "../logger.js";

/**
 * Resolve with `promise`, or with undefined once `ms` pass. Cost capture
 * waits this way so a slow price lookup or writeback leaves a call unpriced
 * instead of holding a chat step or a transcript save.
 */
export function waitAtMost<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`[call-cost] ${what} took over ${ms}ms; call left unpriced`);
      resolve(undefined);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
