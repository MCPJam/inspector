import {
  attachAuthChallenge,
  extractAuthChallenge,
  isUnauthorized401,
} from "./errors.js";
import type { AuthChallengeRecorder } from "./http-error-fetch.js";
/**
 * The transport's auth-provider error drops its JSON-RPC id. Serialize calls
 * on that transport so reset cannot close a sibling call in flight.
 * Different servers remain concurrent.
 */
const queues = new WeakMap<object, Map<string, Promise<void>>>();

export async function isolateAuthChallenge<T>(
  manager: object,
  key: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let queue = queues.get(manager);
  if (!queue) queues.set(manager, (queue = new Map()));
  const previous = queue.get(key) ?? Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.set(key, completed);
  try {
    if (signal) {
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        previous.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
      signal.throwIfAborted();
    } else {
      await previous;
    }
    return await operation();
  } finally {
    // A cancelled waiter must not let the next caller overtake its predecessor.
    void previous.then(() => {
      release();
      if (queue.get(key) === completed) queue.delete(key);
    });
  }
}

export function matchingRecordedChallenge(
  recorder: AuthChallengeRecorder | undefined,
  startedAt: number,
  operationKey: string | undefined
) {
  const recorded = operationKey
    ? recorder?.byOperation?.get(operationKey)
    : undefined;
  return recorded && recorded.at >= startedAt ? recorded.challenge : undefined;
}

/** The provider error drops headers; recover only this operation's challenge. */
export function attachRecordedAuthChallenge(
  recorder: AuthChallengeRecorder | undefined,
  error: unknown,
  startedAt: number,
  operationKey: string | undefined
): void {
  const challenge = matchingRecordedChallenge(
    recorder,
    startedAt,
    operationKey
  );
  if (challenge && isUnauthorized401(error) && !extractAuthChallenge(error))
    attachAuthChallenge(error, challenge);
}
