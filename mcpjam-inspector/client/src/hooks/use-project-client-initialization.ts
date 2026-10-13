import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ConvexError } from "convex/values";
import { isAuthorizationRefusal } from "@/lib/authorization-refusal";
import { isConvexQueryUnavailable } from "@/lib/convex-error";
import { reportCaught } from "@/lib/error-reporting";

/** Waits before the 2nd, 3rd and 4th attempt; then the user gets a Retry. */
const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];

const NO_ACCESS_MESSAGE =
  "You don't have access to set up clients in this project.";

export type ProjectClientInitIntent = "default" | "comparison";

export type ProjectClientInitState =
  | { status: "idle" }
  /** A request is in flight or an automatic retry is scheduled. */
  | { status: "pending" }
  | { status: "done" }
  /** `refused`: retrying cannot help, so no Retry is offered. */
  | { status: "failed"; refused: boolean; message: string };

const IDLE: ProjectClientInitState = { status: "idle" };
const PENDING: ProjectClientInitState = { status: "pending" };
const DONE: ProjectClientInitState = { status: "done" };

type Failure = { refused: boolean; message: string; retryAfterMs?: number };

function classifyFailure(error: unknown): Failure {
  if (isAuthorizationRefusal(error)) {
    return { refused: true, message: NO_ACCESS_MESSAGE };
  }
  // A backend without the function: retrying and reporting cannot help.
  if (error instanceof Error && isConvexQueryUnavailable(error)) {
    return {
      refused: true,
      message: "Client setup isn't available right now. Try again later.",
    };
  }
  const data =
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null
      ? (error.data as {
          code?: unknown;
          message?: unknown;
          retryAfterMs?: unknown;
        })
      : null;
  if (data?.code === "FORBIDDEN") {
    return { refused: true, message: NO_ACCESS_MESSAGE };
  }
  if (data?.code === "VALIDATION") {
    return {
      refused: true,
      // Without its own message, the payload's JSON is all the error says.
      message:
        typeof data.message === "string" && data.message.trim()
          ? data.message
          : "Could not set up a client in this project. Contact support.",
    };
  }
  if (data?.code === "rate_limited") {
    return {
      refused: false,
      message: "",
      retryAfterMs:
        typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined,
    };
  }
  // Drops refusals and auth churn itself; anything else is a real fault.
  reportCaught(error, { source: "project-client-initialization" });
  return { refused: false, message: "" };
}

/** The failed state to settle on, or how long to wait before trying again. */
function afterFailure(
  failure: Failure,
  attempt: number,
): ProjectClientInitState | number {
  if (failure.refused || attempt >= RETRY_DELAYS_MS.length) {
    return {
      status: "failed",
      refused: failure.refused,
      message: failure.message,
    };
  }
  return Math.max(RETRY_DELAYS_MS[attempt], failure.retryAfterMs ?? 0);
}

type Attempt<T> = {
  run: () => Promise<T>;
  /** False once the caller has moved to another project or unmounted. */
  isCurrent: () => boolean;
  isNeeded: () => boolean;
  nextAttempt: () => number;
  settle: (state: ProjectClientInitState) => void;
  retryIn: (delayMs: number) => void;
  /** Runs even after the caller left, so its result can still be saved. */
  onSuccess: (result: T) => void;
};

/** One request, and what its outcome means for the next step. */
function runAttempt<T>(attempt: Attempt<T>): Promise<void> {
  return attempt.run().then(
    (result) => {
      // The list may have refreshed first; IDLE lets a later empty list ensure.
      if (attempt.isCurrent()) attempt.settle(attempt.isNeeded() ? DONE : IDLE);
      attempt.onSuccess(result);
    },
    (error: unknown) => {
      if (!attempt.isCurrent()) return;
      const failure = classifyFailure(error);
      // Another caller satisfied the need meanwhile: nothing to report.
      if (!attempt.isNeeded()) return attempt.settle(IDLE);
      const next = afterFailure(failure, attempt.nextAttempt());
      if (typeof next === "number") attempt.retryIn(next);
      else attempt.settle(next);
    },
  );
}

type Published = { state: ProjectClientInitState; retry: () => void };
const publishedByKey = new Map<string, Published>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function usePublished(key: string | null, { state, retry }: Published) {
  useEffect(() => {
    if (!key) return;
    publishedByKey.set(key, { state, retry });
    emit();
    return () => {
      publishedByKey.delete(key);
      emit();
    };
  }, [key, state, retry]);
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

function useRetryTimer() {
  const timerRef = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const schedule = useCallback((fire: () => void, delayMs: number) => {
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      fire();
    }, delayMs);
  }, []);
  return { clear, schedule };
}

type InitOptions<T> = {
  projectId: string | null;
  intent: ProjectClientInitIntent;
  needed: boolean;
  /** Called only with a project; `needed` gates when. */
  run: (projectId: string) => Promise<T>;
  onSuccess?: (result: T) => void;
};

/**
 * The state of whichever component is initializing this project's clients,
 * for a surface that shows it without owning the request (the Connect client
 * selector shows what `ClientSelectionSync` is doing).
 */
export function useProjectClientInitStatus(
  projectId: string | null,
  intent: ProjectClientInitIntent,
): Published | null {
  const key = projectId ? `${projectId}:${intent}` : null;
  return useSyncExternalStore(subscribe, () =>
    key ? (publishedByKey.get(key) ?? null) : null,
  );
}

/**
 * Runs one project-initialization request while `needed` holds, with bounded
 * retries, and exposes its state.
 *
 * Tracked per project and intent, so a finished default ensure never stands
 * in for a comparison request. A request is never started twice for the same
 * key while one is in flight. The backend is what makes concurrent callers in
 * other components, tabs or devices converge; this only avoids local repeats.
 *
 * Transient failures retry after 1s, 4s and 10s, or after the backend's
 * `retryAfterMs` when that is longer, then stop with a Retry. Refusals do not
 * retry. When `needed` turns false (another caller's client arrived) pending
 * retries are cancelled and any error is cleared. A failure for a project the
 * caller has left is dropped; a success still reaches `onSuccess`, which
 * decides what to save for that project and what to show for the current one.
 */
export function useProjectClientInitialization<T>({
  projectId,
  intent,
  needed,
  run,
  onSuccess,
}: InitOptions<T>): Published {
  const key = projectId ? `${projectId}:${intent}` : null;
  const [entry, setEntry] = useState({ key, state: IDLE });
  const state = entry.key === key ? entry.state : IDLE;
  const latest = useLatest({ run, onSuccess, needed });
  const keyRef = useRef(key);
  const attemptsRef = useRef(0);
  const inFlightRef = useRef(new Set<string>());
  const { clear: clearTimer, schedule } = useRetryTimer();
  const resetTo = useCallback(
    (state: ProjectClientInitState) => setEntry({ key, state }),
    [key],
  );

  useEffect(() => {
    keyRef.current = key;
    attemptsRef.current = 0;
    return () => {
      keyRef.current = null;
      clearTimer();
    };
  }, [key, clearTimer]);

  useEffect(() => {
    if (needed) return;
    clearTimer();
    attemptsRef.current = 0;
    resetTo(IDLE);
  }, [needed, clearTimer, resetTo]);

  useEffect(() => {
    if (!projectId || !key || !needed || state.status !== "idle") return;
    // Back on a key mid-request: PENDING so its retry timer's IDLE re-runs this.
    if (inFlightRef.current.has(key)) {
      resetTo(PENDING);
      return;
    }
    inFlightRef.current.add(key);
    resetTo(PENDING);
    const isCurrent = () => keyRef.current === key;
    void runAttempt({
      run: () => latest.current.run(projectId),
      isCurrent,
      isNeeded: () => latest.current.needed,
      nextAttempt: () => attemptsRef.current++,
      settle: resetTo,
      retryIn: (delayMs) =>
        schedule(() => {
          if (isCurrent()) resetTo(IDLE);
        }, delayMs),
      onSuccess: (result) => {
        if (isCurrent()) attemptsRef.current = 0;
        latest.current.onSuccess?.(result);
      },
    }).finally(() => {
      inFlightRef.current.delete(key);
    });
  }, [key, needed, state.status, resetTo, schedule, latest]);

  const retry = useCallback(() => {
    clearTimer();
    attemptsRef.current = 0;
    resetTo(IDLE);
  }, [clearTimer, resetTo]);

  const published = { state, retry };
  usePublished(key, published);
  return published;
}
