import {
  humanizeSwarmAttemptError,
  isTransientSpendRefusal,
} from "../../../shared/swarm-attempt-error.js";
import {
  abortableSleep,
  clampDelay,
  defaultJitter,
} from "../../utils/run-supervisor/backoff.js";

export interface SpendRefusal {
  code?: string;
  refusalReason?: string;
  retryAfterMs?: number;
  httpStatus?: number;
  stepIndex?: number;
  outstandingHolds?: number;
}

export function spendRefusalOf(error: unknown): SpendRefusal | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("refusal" in error) return error.refusal as SpendRefusal | undefined;
  // A recorded turn can carry executed tools; only its explicit refusal is safe.
  if (error instanceof Error && error.name === "RecordedAssistantTurnError")
    return undefined;
  if (!(error instanceof Error)) return undefined;
  const info = humanizeSwarmAttemptError(error.message);
  return info.refusalReason ? info : undefined;
}

/** Shared by all persona and host calls in one session. */
export class AdmissionWaitBudget {
  remainingMs: number;
  constructor(totalMs = 5 * 60_000, readonly maxAttemptsPerCall = 8) {
    this.remainingMs = totalMs;
  }
  take(delayMs: number): boolean {
    if (delayMs > this.remainingMs) return false;
    this.remainingMs -= delayMs;
    return true;
  }
}

export async function withAdmissionRetry<T>(
  op: () => Promise<T>,
  options: {
    budget: AdmissionWaitBudget;
    signal?: AbortSignal;
    /** Pause the turn clock; return a function that re-arms it after waiting. */
    onWait?: (delayMs: number) => void | (() => void);
  },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      return await op();
    } catch (error) {
      const refusal = spendRefusalOf(error);
      if (
        !refusal ||
        !isTransientSpendRefusal(refusal.code, refusal.refusalReason) ||
        ++attempt >= options.budget.maxAttemptsPerCall
      )
        throw error;
      const base = Number.isFinite(refusal.retryAfterMs)
        ? refusal.retryAfterMs!
        : 15_000;
      const delay = Math.round(
        defaultJitter(clampDelay(base * attempt, 5_000, 60_000)),
      );
      if (!options.budget.take(delay)) throw error;
      const resume = options.onWait?.(delay);
      try {
        await abortableSleep(delay, options.signal);
      } finally {
        resume?.();
      }
      options.signal?.throwIfAborted();
    }
  }
}
