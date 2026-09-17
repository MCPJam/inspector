/**
 * One clock, one signal, one name for what fired.
 *
 * Every deadline in the eval and swarm runners used to be either a bare
 * `setTimeout` racing a promise — which leaves the loser running — or an
 * `AbortSignal.timeout` whose reason says only "aborted". Both lose the fact a
 * reader most needs: WHICH budget expired. A trial that stops after ten minutes
 * because its iteration cap fired and a trial that stops after ten minutes
 * because a single turn hung are different bugs with the same symptom.
 *
 * `withDeadline` composes a child signal that aborts when EITHER the parent
 * aborts or this budget expires, and remembers which of the two it was. The
 * abort reason it raises is an `Error` whose `name` is `"AbortError"` — not a
 * `TimeoutError` — and which carries `clock` as a property:
 *
 *   - `name === "AbortError"` because the runners' catch blocks recognise
 *     exactly that string (`evals-runner.ts` widens its abort branch on it).
 *     A `TimeoutError` would fall through to the full failure path: widget
 *     capture, an SSE failure event, a `failed` write — for what is an
 *     infrastructure event, not a verdict.
 *   - `clock` because §3.4 requires a timeout outcome to name its clock
 *     (`iteration_timeout` vs `run_timeout` vs `turn_timeout`), never a bare
 *     "aborted".
 *
 * `firedClock()` reports only THIS handle's own clock, deliberately. Deadlines
 * nest — a turn inside an iteration inside a run — and a caller distinguishing
 * "my unit ran out" from "the whole run was cancelled" compares its own
 * `firedClock()` against the parent's `aborted`. Inheriting the parent's clock
 * would erase exactly that distinction. {@link deadlineClockOf} is the escape
 * hatch for the other direction: read the clock off an abort reason or a caught
 * error, whichever level raised it.
 */
import { composeAbortSignals } from "@mcpjam/sdk";
import {
  isDeadlineClock,
  type DeadlineClock,
  type TimeoutMetadata,
} from "@/shared/turn-outcome";

/**
 * Which budget a deadline belongs to, and the attribution a fired one persists.
 *
 * BOTH now live in `shared/turn-outcome.ts` and are re-exported here. They moved
 * because a persisted turn-outcome record carries them, and that record is read
 * by the client and hand-mirrored by the backend — neither of which can import a
 * `server/utils/run-supervisor` module. This file keeps the names so every
 * existing importer is unaffected.
 */
export { DEADLINE_CLOCKS } from "@/shared/turn-outcome";
export type { DeadlineClock, TimeoutMetadata };

/** The abort reason a fired deadline raises. */
export interface DeadlineAbortError extends Error {
  name: "AbortError";
  clock: DeadlineClock;
  budgetMs: number;
}

export interface DeadlineHandle {
  /** Aborts when the parent aborts OR this budget expires. */
  readonly signal: AbortSignal;
  /** The clock this handle owns. */
  readonly clock: DeadlineClock;
  /** The budget it was given, in ms. */
  readonly budgetMs: number;
  /** This handle's clock once IT fired; `undefined` while it has not. */
  firedClock(): DeadlineClock | undefined;
  /** Wall time since the handle was created, in ms. */
  elapsedMs(): number;
  /** What is left of this budget, floored at 0. */
  remainingMs(): number;
  /** Clear the timer and drop the parent listener. Idempotent. */
  dispose(): void;
}

export interface WithDeadlineOptions {
  /** Injectable for tests; production leaves it alone. */
  now?: () => number;
}

/**
 * The clock named by `error`, when it is (or wraps) a deadline abort.
 *
 * BOTH marks are required on the same object: the `AbortError` name AND a clock
 * from the closed set. A `clock` property on something that is not an abort is
 * not a deadline — it is a coincidence, and labelling an unrelated failure with
 * a timeout clock would put a wrong `metadata.timeout.clock` on a persisted
 * outcome. Wrapping still works, because each link is checked before `cause` is
 * followed.
 */
export function deadlineClockOf(error: unknown): DeadlineClock | undefined {
  let current: unknown = error;
  // Depth-capped and self-guarded like `shared/abort-errors.ts`: a `cause`
  // chain is caller-supplied and can be cyclic.
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object") return undefined;
    const candidate = current as {
      name?: unknown;
      clock?: unknown;
      cause?: unknown;
    };
    if (
      candidate.name === "AbortError" &&
      typeof candidate.clock === "string" &&
      isDeadlineClock(candidate.clock)
    ) {
      return candidate.clock;
    }
    const cause: unknown = candidate.cause;
    if (cause === undefined || cause === current) return undefined;
    current = cause;
  }
  return undefined;
}



/**
 * `setTimeout`'s 32-bit ceiling (~24.8 days). Past it Node truncates to 1ms and
 * warns — so a budget larger than this, or `Infinity`, arms no timer at all.
 */
const MAX_TIMER_MS = 2_147_483_647;

function deadlineAbortError(
  clock: DeadlineClock,
  budgetMs: number,
): DeadlineAbortError {
  const error = new Error(
    `${clock} budget of ${budgetMs}ms expired`,
  ) as DeadlineAbortError;
  error.name = "AbortError";
  error.clock = clock;
  error.budgetMs = budgetMs;
  return error;
}

/**
 * Compose `parent` with a fresh deadline of `budgetMs`.
 *
 * A non-positive budget aborts synchronously — a unit handed no time left must
 * not start work that can only be thrown away, and `remainingMs()` reading 0
 * before the first `await` is what lets a caller skip the attempt entirely.
 *
 * ALWAYS `dispose()`, in a `finally`. The timer is unref'd so a pending
 * twelve-hour run deadline cannot by itself hold a CLI process open, but the
 * parent listener is a real reference and leaks per unit without it.
 */
export function withDeadline(
  parent: AbortSignal | undefined,
  budgetMs: number,
  clock: DeadlineClock,
  options: WithDeadlineOptions = {},
): DeadlineHandle {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let fired: DeadlineClock | undefined;
  let disposed = false;

  const fire = (): void => {
    if (fired || controller.signal.aborted) return;
    fired = clock;
    controller.abort(deadlineAbortError(clock, budgetMs));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (budgetMs <= 0) {
    fire();
  } else if (budgetMs <= MAX_TIMER_MS) {
    timer = setTimeout(fire, budgetMs);
    // A Node `Timeout`; absent under other runtimes and in some fake-timer
    // implementations, hence the optional call.
    (timer as { unref?: () => void }).unref?.();
  }
  // Above `MAX_TIMER_MS` (or `Infinity`) NO timer is armed and this deadline
  // simply never fires. That is the honest reading of "no bound" — and it is
  // the safe one: `setTimeout` silently truncates anything past the 32-bit
  // range to 1ms, so arming it would fire the deadline IMMEDIATELY, which is
  // the exact opposite of what an unbounded budget asked for.

  const composed = parent
    ? composeAbortSignals([parent, controller.signal])
    : { signal: controller.signal, dispose: () => {} };

  return {
    signal: composed.signal,
    clock,
    budgetMs,
    firedClock: () => fired,
    elapsedMs: () => Math.max(0, now() - startedAt),
    remainingMs: () => Math.max(0, budgetMs - (now() - startedAt)),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      composed.dispose();
    },
  };
}

/**
 * Run `fn` under a deadline and always tear it down.
 *
 * The handle is passed in so the callback can read `remainingMs()` — a nested
 * budget (a capacity retry inside a unit, say) is clamped to what is left of
 * the enclosing one rather than allowed to outlive it.
 */
export async function runWithDeadline<T>(
  parent: AbortSignal | undefined,
  budgetMs: number,
  clock: DeadlineClock,
  fn: (handle: DeadlineHandle) => Promise<T>,
  options: WithDeadlineOptions = {},
): Promise<T> {
  const handle = withDeadline(parent, budgetMs, clock, options);
  try {
    return await fn(handle);
  } finally {
    handle.dispose();
  }
}
