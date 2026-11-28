import { logger } from "../utils/logger.js";
import {
  BEARER_REFUSED_PREFIX,
  type RenewingBearer,
} from "../utils/run-bearer.js";

/** Answers that end renewal: the backend refused this lease or this owner. */
const REFUSED_STATUSES = new Set([400, 403, 404, 409]);
/** The soonest a renewal is tried, however short the token's life. */
const MIN_RENEW_DELAY_MS = 5_000;
/** The wait before retrying a renewal that failed for a transient reason. */
const RETRY_DELAY_MS = 15_000;
/** Too close to expiry for a renewal to arrive in time; the run stops with the token. */
const MIN_RETRY_WINDOW_MS = 2_000;

export type RenewResponse = { status: number; body: unknown };

export interface JobBearer extends RenewingBearer {
  /** Why the backend refused to renew the token, or null. */
  refusal(): string | null;
  /** Ends renewal. Call once the run is over. */
  stop(): void;
}

function readCredentials(
  body: unknown,
): { bearer: string; bearerExpiresAt: number } | null {
  const credentials = (body as { credentials?: unknown } | null)?.credentials;
  if (!credentials || typeof credentials !== "object") return null;
  const { bearer, bearerExpiresAt } = credentials as Record<string, unknown>;
  return typeof bearer === "string" && typeof bearerExpiresAt === "number"
    ? { bearer, bearerExpiresAt }
    : null;
}

function readError(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

/**
 * A scheduled run's job token, renewed at half its remaining life by proving
 * the claim's lease. The backend reruns the claim's owner checks on every
 * renewal. A refusal ends renewal and makes the next use of the token throw
 * `token_renewal_failed: <reason>`, so the run stops at its next call rather
 * than going on until the token expires. A transient failure is retried while
 * the token still has time left. The writes that end the run use `last()`.
 */
export function startJobBearer(options: {
  triggerId: string;
  leaseToken: string;
  bearer: string;
  bearerExpiresAt: number;
  renew: (body: {
    triggerId: string;
    leaseToken: string;
  }) => Promise<RenewResponse>;
  now?: () => number;
}): JobBearer {
  const now = options.now ?? Date.now;
  const { triggerId } = options;
  let token = options.bearer;
  let expiresAt = options.bearerExpiresAt;
  let refused: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: Array<(token: string) => void> = [];

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void renewNow(), delayMs);
    timer.unref?.();
  };
  const halfLife = () => Math.max((expiresAt - now()) / 2, MIN_RENEW_DELAY_MS);

  async function renewNow(): Promise<void> {
    let response: RenewResponse | null = null;
    try {
      response = await options.renew({
        triggerId,
        leaseToken: options.leaseToken,
      });
    } catch (error) {
      logger.warn("[scheduled-evals] job token renewal failed; retrying", {
        triggerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (stopped) return;
    const credentials =
      response?.status === 200 ? readCredentials(response.body) : null;
    if (credentials) {
      token = credentials.bearer;
      expiresAt = credentials.bearerExpiresAt;
      for (const listener of listeners) listener(token);
      logger.info("[scheduled-evals] job token renewed", {
        triggerId,
        expiresAt,
      });
      schedule(halfLife());
      return;
    }
    if (response && REFUSED_STATUSES.has(response.status)) {
      refused = readError(response.body) ?? `http_${response.status}`;
      logger.warn("[scheduled-evals] job token renewal refused", {
        triggerId,
        reason: refused,
      });
      return;
    }
    // Near expiry the wait shrinks, so the last attempt lands while the
    // token still works.
    const remaining = expiresAt - now();
    if (remaining > MIN_RETRY_WINDOW_MS) {
      schedule(Math.min(RETRY_DELAY_MS, remaining / 2));
    }
  }

  schedule(halfLife());
  return {
    current() {
      if (refused) throw new Error(`${BEARER_REFUSED_PREFIX}${refused}`);
      return token;
    },
    last: () => token,
    onRenew(listener) {
      listeners.push(listener);
    },
    refusal: () => refused,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
