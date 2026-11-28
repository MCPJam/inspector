/**
 * What a failed goal start means for a swarm launch, for the launch engine
 * to act on (`run-group-launch/session.ts` owns the waits, retries and caps).
 *
 *   400, 404, 422 and any other refusal of that goal alone  item_failed
 *   429 RATE_LIMITED with Retry-After                       wait that long
 *   5xx, network, anything unexpected                       retry
 *   402, an MCPJam usage or plan limit (the daily run
 *   limit among them), 409 swarm_funding_changed, a
 *   policy 403, a draining server                           stop
 *   401                                                     stop, AUTH_EXPIRED
 *
 * A stop is launch-wide because every goal after it would meet the same
 * refusal: spending a request on each only repeats it.
 */
import { WebRouteError } from "../../routes/web/errors.js";
import { SwarmAgentError } from "../swarm-agent.js";
import { isAccountLimit } from "../../../shared/swarm-attempt-error.js";
import { SWARM_FUNDING_CHANGED_CODE } from "../../../shared/swarm-sponsorship.js";
import type { LaunchError } from "../../../shared/run-group-launch.js";
import type { ItemFailure } from "../run-group-launch/types.js";

/** The wait for a throttle that did not say how long (the backend always does). */
export const DEFAULT_RATE_LIMIT_WAIT_MS = 5_000;
/** A stop for a credential that expired mid-launch; a replay or resume finishes it. */
export const AUTH_EXPIRED_CODE = "AUTH_EXPIRED";

const UNREACHABLE_MESSAGE =
  "MCPJam could not start this goal's run. Launch again to retry it.";
const AUTH_EXPIRED_MESSAGE =
  "The sign-in this launch used expired before every goal started. Launch it again to start the rest.";

/** `Retry-After` off a refusal, in milliseconds, when it carried a number. */
function retryAfterMsOf(error: WebRouteError): number | undefined {
  const raw = error.headers?.["Retry-After"];
  return raw !== undefined && /^\d{1,7}$/.test(raw)
    ? Number(raw) * 1000
    : undefined;
}

/** The backend's own code, which `launchJourneyRun` keeps in `details.code`. */
function detailCodeOf(error: WebRouteError): string | undefined {
  const code = error.details?.code;
  return typeof code === "string" && code ? code : undefined;
}

/**
 * What the launch record keeps about a failed goal start. Only a route
 * error's message is fit to show; anything else (a transport failure, a
 * backend 5xx body) is replaced by a sentence of ours.
 */
export function describeSwarmLaunchError(error: unknown): LaunchError {
  if (error instanceof WebRouteError) {
    return {
      status: error.status,
      code: detailCodeOf(error) ?? error.code,
      message: error.message,
    };
  }
  if (error instanceof SwarmAgentError) {
    return { status: error.status, message: UNREACHABLE_MESSAGE };
  }
  return { message: UNREACHABLE_MESSAGE };
}

/** What a swarm launch does with `error`, thrown while starting one goal's run. */
export function classifySwarmLaunchError(error: unknown): ItemFailure {
  if (!(error instanceof WebRouteError) || error.status >= 500) return "retry";
  const retryAfterMs = retryAfterMsOf(error);
  const stop = (reason: LaunchError): ItemFailure => ({
    stop: reason,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
  if (error.status === 401) {
    return stop({
      status: 401,
      code: AUTH_EXPIRED_CODE,
      message: AUTH_EXPIRED_MESSAGE,
    });
  }
  const detailCode = detailCodeOf(error);
  if (
    isAccountLimit(error.message, detailCode) ||
    error.status === 402 ||
    error.status === 403 ||
    (error.status === 409 && detailCode === SWARM_FUNDING_CHANGED_CODE) ||
    error.details?.reason === "SERVER_DRAINING"
  ) {
    return stop(describeSwarmLaunchError(error));
  }
  if (error.status === 429) {
    return { wait: retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS };
  }
  return "item_failed";
}
