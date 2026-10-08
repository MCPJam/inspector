import { ConvexError } from "convex/values";
import { describePluginError } from "@/shared/plugin-diagnostics";
import { PluginDescribedError } from "@/shared/plugin-operation";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

/**
 * One retry for a call refused only because this tab's sign-in lapsed.
 *
 * A token can run out between a request leaving and the server reading it
 * (a page that slept, a refresh that landed a moment late). The backend then
 * refuses the call with its `unauthenticated` kind before doing anything, so
 * sending it again once the session is back is safe. Each call retries at
 * most once; a second refusal, or no session within the wait, ends in the
 * plain "sign-in expired" error below.
 */

/** The code the refusal is logged and described under. */
export const SIGN_IN_EXPIRED_CODE = "SIGN_IN_EXPIRED";

/** How long a refused call waits for the session to come back. */
export const SIGN_IN_RETRY_WAIT_MS = 15_000;

/** Shown as is by forms and Apps; `code` names it in Logs. */
export class SignInExpiredError extends PluginDescribedError {
  constructor() {
    super(
      describePluginError(SIGN_IN_EXPIRED_CODE) ??
        "Your sign-in expired before this finished.",
      SIGN_IN_EXPIRED_CODE,
    );
    this.name = "SignInExpiredError";
  }
}

/** The backend's refusal for a request that arrived with no identity. */
export function isIdentityRefusal(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "unauthenticated"
  );
}

function sessionUsable(): boolean {
  const state = useSessionRefreshStore.getState();
  return state.authConfirmed && !state.queriesPaused && state.status === "idle";
}

/**
 * Wait until the server has accepted a token after `sinceEpoch` (the epoch
 * read before the refused call was sent). At the deadline, a session that is
 * usable anyway still counts: the refusal may have come from a token that
 * was renewed before this wait began.
 */
export function waitForSessionAuth({
  sinceEpoch,
  timeoutMs = SIGN_IN_RETRY_WAIT_MS,
  signal,
}: {
  sinceEpoch: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const renewed = () =>
    useSessionRefreshStore.getState().authEpoch > sinceEpoch && sessionUsable();
  if (renewed()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(sessionUsable()), timeoutMs);
    const unsubscribe = useSessionRefreshStore.subscribe(() => {
      if (renewed()) finish(true);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) finish(false);
  });
}

/**
 * Run `call`; if the backend refused it for missing identity, wait for the
 * session to come back and run it once more. Anything else is rethrown.
 */
export async function retryOnceAfterSignIn<T>(
  call: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const sinceEpoch = useSessionRefreshStore.getState().authEpoch;
  try {
    return await call();
  } catch (error) {
    if (!isIdentityRefusal(error)) throw error;
  }
  const back = await waitForSessionAuth({ sinceEpoch, ...options });
  options.signal?.throwIfAborted();
  if (!back) throw new SignInExpiredError();
  try {
    return await call();
  } catch (error) {
    if (isIdentityRefusal(error)) throw new SignInExpiredError();
    throw error;
  }
}
