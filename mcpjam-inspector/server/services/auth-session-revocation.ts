import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { decodeJwt } from "jose";
import { getInspectorClientRuntimeConfig } from "../env.js";
import { logger } from "../utils/logger.js";
import { markSessionRevokedLocally } from "./revoked-session-cache.js";

export type SessionRevocationResult =
  | { revoked: true }
  | {
      revoked: false;
      reason:
        "no_identity" | "no_session" | "not_configured" | "timeout" | "failed";
    };

export const SESSION_REVOCATION_TIMEOUT_MS = 3_000;

export interface SessionRevocationDeps {
  convexUrl?: string;
  /** Calls the mutation as the bearer of `token`. Injectable for tests. */
  revoke?: (convexUrl: string, token: string) => Promise<unknown>;
}

async function revokeViaConvex(
  convexUrl: string,
  token: string,
): Promise<unknown> {
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  return await client.mutation("authSessions:revokeCurrentSession" as any, {});
}

function isRevocationResponse(
  value: unknown,
): value is { revoked: boolean; reason?: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { revoked?: unknown }).revoked === "boolean"
  );
}

/**
 * Revoke the WorkOS AuthKit session an access token belongs to, in Convex.
 *
 * WorkOS's logout ends a session — no more refreshes — but cannot recall the
 * access tokens it already issued, and Convex accepts those on signature and
 * expiry alone. The backend's `authSessions:revokeCurrentSession` records the
 * token's session id (`sid`) so every later request carrying a token from that
 * session is treated as signed out (see the backend's
 * `lib/sessionRevocation.ts`).
 *
 * The mutation only ever revokes the session of the token that calls it, so
 * this is safe to call with any bearer: a token without a session id, or one
 * Convex does not accept, simply revokes nothing.
 *
 * BEST EFFORT by contract. Callers are sign-out paths, and a sign-out must
 * never wait on, or fail because of, this call. It resolves — never rejects —
 * within `timeoutMs`.
 */
export async function revokeAuthKitSession(
  token: string,
  options: SessionRevocationDeps & { timeoutMs?: number } = {},
): Promise<SessionRevocationResult> {
  const convexUrl =
    options.convexUrl ?? getInspectorClientRuntimeConfig().convexUrl;
  if (!convexUrl || !token) {
    return { revoked: false, reason: "not_configured" };
  }
  const revoke = options.revoke ?? revokeViaConvex;
  const timeoutMs = options.timeoutMs ?? SESSION_REVOCATION_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([revoke(convexUrl, token), timedOut]);
    if (outcome === "timeout") return { revoked: false, reason: "timeout" };
    if (!isRevocationResponse(outcome)) {
      return { revoked: false, reason: "failed" };
    }
    if (outcome.revoked) return { revoked: true };
    return {
      revoked: false,
      reason: outcome.reason === "no_identity" ? "no_identity" : "no_session",
    };
  } catch {
    return { revoked: false, reason: "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Sign-out: local mark, durable acknowledgment, bounded retries (MJ-011)
// ---------------------------------------------------------------------------

/**
 * What `/api/web/auth-session/revoke` reports.
 *
 * `revoked: true` means the backend acknowledged a durable record of the
 * revocation — never less. A timeout or failure is reported as such, with
 * `status: "pending"` when retries were scheduled and `status: "failed"` when
 * none could be.
 */
export type SignOutRevocationResult =
  | { revoked: true }
  | { revoked: false; reason: "no_identity" | "no_session" | "not_configured" }
  | {
      revoked: false;
      reason: "timeout" | "failed";
      status: "pending" | "failed";
    };

/** Delay before each retry of an unacknowledged revocation (~9 min in all). */
export const SESSION_REVOCATION_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

/** No user waits on a retry, so it may take longer than the first attempt. */
const RETRY_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Retries in flight at once. Each holds the access token being revoked until
 * it settles, so the queue is bounded in size as well as in time.
 */
export const MAX_PENDING_SESSION_REVOCATION_RETRIES = 500;

interface PendingRevocationRetry {
  token: string;
  sid?: string;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingRetries = new Map<string, PendingRevocationRetry>();

/** The unverified `sid` claim of a token, if it has one. */
function sessionIdClaim(token: string): string | undefined {
  try {
    const sid = (decodeJwt(token) as { sid?: unknown }).sid;
    return typeof sid === "string" && sid.length > 0 ? sid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * After the backend acknowledged revoking the session of `token`, remember it
 * here too. Without a gateway-verified sid, the token's own claim is used: the
 * backend verified this very token and revoked the session it names.
 */
function rememberAcknowledged(token: string, verifiedSid?: string): void {
  markSessionRevokedLocally(verifiedSid ?? sessionIdClaim(token));
}

function retryKey(token: string, sid?: string): string {
  return sid
    ? `sid:${sid}`
    : `token:${createHash("sha256").update(token).digest("hex")}`;
}

type RetryOptions = SessionRevocationDeps & {
  sid?: string;
  delaysMs?: readonly number[];
};

function armRetry(
  key: string,
  entry: PendingRevocationRetry,
  options: RetryOptions,
): void {
  const delays = options.delaysMs ?? SESSION_REVOCATION_RETRY_DELAYS_MS;
  entry.timer = setTimeout(
    () => void runRetry(key, entry, options),
    delays[entry.attempts],
  );
  entry.timer.unref?.();
}

async function runRetry(
  key: string,
  entry: PendingRevocationRetry,
  options: RetryOptions,
): Promise<void> {
  entry.timer = null;
  entry.attempts += 1;
  const result = await revokeAuthKitSession(entry.token, {
    convexUrl: options.convexUrl,
    revoke: options.revoke,
    timeoutMs: RETRY_ATTEMPT_TIMEOUT_MS,
  });
  // Cleared while the attempt was in flight (tests).
  if (pendingRetries.get(key) !== entry) return;

  if (result.revoked) {
    pendingRetries.delete(key);
    rememberAcknowledged(entry.token, entry.sid);
    logger.info("Sign-out revocation acknowledged on retry", {
      event: "auth.session.revoke_retry_succeeded",
      attempts: entry.attempts,
    });
    return;
  }
  if (result.reason !== "timeout" && result.reason !== "failed") {
    // The backend answered, with nothing to revoke: not a transient failure.
    pendingRetries.delete(key);
    logger.info("Sign-out revocation retry ended without a session", {
      event: "auth.session.revoke_retry_ended",
      reason: result.reason,
      attempts: entry.attempts,
    });
    return;
  }
  const delays = options.delaysMs ?? SESSION_REVOCATION_RETRY_DELAYS_MS;
  if (entry.attempts >= delays.length) {
    pendingRetries.delete(key);
    logger.error(
      "Sign-out revocation was never acknowledged by the backend",
      new Error("Sign-out revocation retries exhausted"),
      {
        event: "auth.session.revoke_retry_exhausted",
        reason: result.reason,
        attempts: entry.attempts,
      },
    );
    return;
  }
  armRetry(key, entry, options);
}

/**
 * Keep asking the backend to record the revocation of `token`'s session, in
 * the background, with backoff, until it acknowledges, answers that there is
 * nothing to revoke, or the retries run out. Returns false when no retry could
 * be scheduled (the queue is full). A second request for a session already
 * being retried joins it.
 *
 * In-process: a restart drops what is pending here. The session is still
 * ended at the identity provider by the sign-out itself, and the backend
 * records that revocation from the provider's side — which is what other
 * replicas and a restarted process learn from the feed.
 */
export function scheduleSessionRevocationRetry(
  token: string,
  options: RetryOptions = {},
): boolean {
  const key = retryKey(token, options.sid);
  if (pendingRetries.has(key)) return true;
  if (pendingRetries.size >= MAX_PENDING_SESSION_REVOCATION_RETRIES) {
    logger.warn("Sign-out revocation retry queue is full", {
      event: "auth.session.revoke_retry_dropped",
      pending: pendingRetries.size,
    });
    return false;
  }
  const entry: PendingRevocationRetry = {
    token,
    ...(options.sid ? { sid: options.sid } : {}),
    attempts: 0,
    timer: null,
  };
  pendingRetries.set(key, entry);
  armRetry(key, entry, options);
  return true;
}

/**
 * Sign-out's revocation, in order:
 *
 *   1. the session (when the gateway verified its id) is refused by THIS
 *      process at once;
 *   2. the backend is asked to record the revocation durably — the record
 *      Convex checks on every request and the feed every replica reads;
 *   3. `{ revoked: true }` is reported only once that write is acknowledged.
 *      A timeout or failure is reported as pending (retries scheduled) or
 *      failed — never as revoked.
 *
 * Resolves, never rejects, within the first attempt's timeout.
 */
export async function revokeSessionWithAcknowledgment(
  token: string,
  options: SessionRevocationDeps & {
    /** The session id `bearerAuthMiddleware` verified, when it verified one. */
    verifiedSid?: string;
    timeoutMs?: number;
    retryDelaysMs?: readonly number[];
  } = {},
): Promise<SignOutRevocationResult> {
  markSessionRevokedLocally(options.verifiedSid);
  const result = await revokeAuthKitSession(token, options);
  if (result.revoked) {
    rememberAcknowledged(token, options.verifiedSid);
    return result;
  }
  const { reason } = result;
  if (reason !== "timeout" && reason !== "failed") {
    return { revoked: false, reason };
  }
  const scheduled = scheduleSessionRevocationRetry(token, {
    convexUrl: options.convexUrl,
    revoke: options.revoke,
    sid: options.verifiedSid,
    delaysMs: options.retryDelaysMs,
  });
  return {
    revoked: false,
    reason,
    status: scheduled ? "pending" : "failed",
  };
}

/** Unacknowledged revocations still being retried. */
export function pendingSessionRevocationRetryCount(): number {
  return pendingRetries.size;
}

/** Test-only: drop every pending retry and its timer. */
export function resetSessionRevocationRetriesForTests(): void {
  for (const entry of pendingRetries.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pendingRetries.clear();
}
