import type { TurnAuthorization } from "../services/turn-authorization.js";

/**
 * A bearer that renews while a run goes on. A scheduled eval's job token
 * lasts minutes and its run can last hours, so the worker renews it
 * (`services/scheduled-evals-worker.ts`) and the run reads it at the moment
 * of each call rather than once at the start.
 */
export interface RenewingBearer {
  current(): string;
  /** Called with each renewed token, for a client that keeps one. */
  onRenew(listener: (token: string) => void): void;
}

/** The Convex bearer an eval run calls the backend with. */
export type RunBearer = string | RenewingBearer;

/** The token to send now. */
export function bearerNow(bearer: RunBearer): string {
  return typeof bearer === "string" ? bearer : bearer.current();
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
  const authorization = async () => `Bearer ${bearer.current()}`;
  return {
    start: () => {},
    getAuthorization: authorization,
    getCleanupAuthorization: authorization,
    dispose: () => {},
  };
}
