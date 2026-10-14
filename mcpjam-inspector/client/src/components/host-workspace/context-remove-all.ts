import type { PluginContextRemoveAllResult } from "@/shared/plugin-model-context";
import { ThreadAppError } from "./thread-app-api";

type Outcome = PluginContextRemoveAllResult["outcome"];

/** Waits before re-sending a remove-all whose outcome is unknown. */
export const CONTEXT_REMOVE_ALL_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];

/** The server answered and refused: re-sending the same request can't help.
 * Only a concurrent context write (CONFLICT) is worth another try. */
function refused(error: unknown) {
  return (
    error instanceof ThreadAppError &&
    error.code !== "INSTANCE_CONTEXT_CONFLICT"
  );
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Send one remove-all until the server gives an outcome. Every attempt
 * re-sends the same operation and basis, so a retry is decided by what the
 * person saw and can't clear context they attached afterwards. No outcome
 * (a refusal, retries used up, or the owner went away) means the result is
 * still unknown; the caller keeps the App's context out of the chat.
 */
export async function removeAllAppContext(
  send: () => Promise<Outcome>,
  signal: AbortSignal,
  delays: readonly number[] = CONTEXT_REMOVE_ALL_RETRY_DELAYS_MS,
): Promise<{ outcome: Outcome } | { outcome?: undefined; error: unknown }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt) await wait(delays[attempt - 1]!, signal);
    if (signal.aborted) return { error: signal.reason };
    try {
      return { outcome: await send() };
    } catch (error) {
      lastError = error;
      if (refused(error)) break;
    }
  }
  return { error: lastError };
}
