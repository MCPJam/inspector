import type { TurnAuthorization } from "../services/turn-authorization.js";

/**
 * A bearer that renews while a run goes on. A scheduled eval's job token
 * lasts minutes and its run can last hours, so the worker renews it
 * (`services/scheduled-evals-worker.ts`) and the run reads it at the moment
 * of each call rather than once at the start.
 */
export interface RenewingBearer {
  current(): string;
  /**
   * The last token the backend issued, even after it refused to renew. Only
   * for the writes that end a run: an iteration's terminal state, its
   * uploads, cleanup. The backend still checks it, and it expires on its own.
   */
  last(): string;
  /** Called with each renewed token, for a client that keeps one. */
  onRenew(listener: (token: string) => void): void;
}

/** The Convex bearer an eval run calls the backend with. */
export type RunBearer = string | RenewingBearer;

/** How a renewing bearer's next use fails once the backend refused to renew it. */
export const BEARER_REFUSED_PREFIX = "token_renewal_failed: ";

export function isBearerRefusal(error: unknown): error is Error {
  return (
    error instanceof Error && error.message.startsWith(BEARER_REFUSED_PREFIX)
  );
}

/** The token to send now. */
export function bearerNow(bearer: RunBearer): string {
  return typeof bearer === "string" ? bearer : bearer.current();
}

/**
 * The token for the writes that end a run, which must land after a refused
 * renewal so the run's end is recorded with the reason it stopped. See
 * {@link RenewingBearer.last}.
 */
export function bearerForCleanup(bearer: RunBearer): string {
  return typeof bearer === "string" ? bearer : bearer.last();
}

/** An auth header, or a function that returns the current one. */
export type AuthHeaderSource = string | (() => string);

/** The auth header to send now. */
export function authHeaderNow(source: AuthHeaderSource): string {
  return typeof source === "function" ? source() : source;
}

/** Applies the token now and again on every renewal (`ConvexHttpClient.setAuth`). */
export function followBearer(
  bearer: RunBearer,
  apply: (token: string) => void,
): void {
  apply(bearerNow(bearer));
  if (typeof bearer !== "string") bearer.onRenew(apply);
}

/**
 * The stream engine reads a turn's authorization on every step through this,
 * so a long turn keeps working across a renewal. Undefined for a plain token,
 * which the engine already sends as-is.
 */
export function bearerTurnAuthorization(
  bearer: RunBearer,
): TurnAuthorization | undefined {
  if (typeof bearer === "string") return undefined;
  return {
    start: () => {},
    getAuthorization: async () => `Bearer ${bearer.current()}`,
    getCleanupAuthorization: async () => `Bearer ${bearer.last()}`,
    dispose: () => {},
  };
}
