import type { PluginContextRemoveAllResult } from "@/shared/plugin-model-context";
import { PluginContextUpdateRejected } from "./model-context-controller";
import { ThreadAppError } from "./thread-app-api";

type Outcome = PluginContextRemoveAllResult["outcome"];

/** Waits before re-sending a remove-all whose outcome is unknown. */
export const CONTEXT_REMOVE_ALL_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000,
];

/** Refusals of this exact request: re-sending it can't help. Any other
 * failure (a store timeout, a cancelled request, a gateway page) may have
 * applied, and re-sending the same operation and basis is safe. */
const REFUSALS = new Set([
  "INSTANCE_CONTEXT_DUPLICATE_MISMATCH",
  "INSTANCE_CONTEXT_UNAVAILABLE",
  "INVALID_PLUGIN_INSTANCE_REQUEST",
  "PLUGIN_EXTENSION_DISABLED",
  "PLUGIN_WORKSPACE_DENIED",
]);
function refused(error: unknown) {
  if (error instanceof PluginContextUpdateRejected) return true;
  if (!(error instanceof ThreadAppError)) return false;
  // A context refusal describes the App's context, which re-sending doesn't
  // change. The memory budget is the exception: it frees as Apps close.
  return (
    REFUSALS.has(error.code) ||
    (error.code.startsWith("PLUGIN_CONTEXT_") &&
      error.code !== "PLUGIN_CONTEXT_MEMORY_LIMIT")
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
