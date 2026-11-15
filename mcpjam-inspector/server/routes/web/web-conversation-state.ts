import { ErrorCode, WebRouteError } from "./errors.js";

export interface WebConversationState {
  writable: boolean;
  requireNativeToolDiscovery?: boolean;
}

/** Read authoritative conversation policy before any model or sandbox starts. */
export async function readWebConversationState(
  read: (signal: AbortSignal) => Promise<WebConversationState>,
  requestSignal: AbortSignal,
  timeoutMs = 10_000,
): Promise<WebConversationState> {
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new WebRouteError(
              503,
              ErrorCode.TIMEOUT,
              "Could not verify this conversation's execution requirements. Retry the turn.",
              { retryable: true },
            ),
          );
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
