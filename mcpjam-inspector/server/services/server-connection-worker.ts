/**
 * The worker that advances a connection request one step.
 *
 * The backend owns the state machine and decides what happens next; this owns
 * the part the backend cannot do — reaching an attacker-supplied URL over the
 * network. Every run is: take the lease, do exactly the step the lease response
 * named, report the outcome, release.
 *
 * THE WORKER NEVER DECIDES WHICH STEP TO RUN. It branches on the `status` the
 * lease returned, because the routing rule ("no project yet ⇒ wait", "OAuth ⇒
 * consent", "no auth ⇒ validate") lives in the backend's transition table where
 * it can be enforced. A worker that inferred the step from what it found on the
 * wire would be a second copy of that rule, free to disagree.
 *
 * FAILURE TAXONOMY IS THE POINT OF THIS FILE. Three outcomes look similar in a
 * stack trace and mean completely different things to a user:
 *
 *   retryable          the network misbehaved. Keep the credential, try again.
 *   authentication     the stored token was rejected. Only consent fixes it.
 *   terminal           the endpoint answered and is not a conformant MCP
 *                      server. Retrying changes nothing.
 *
 * Getting this wrong is expensive in both directions: classifying a blip as an
 * auth failure throws away a working grant, and classifying a bad endpoint as
 * retryable burns five attempts before saying so.
 */

import { randomUUID } from "node:crypto";
import { probeMcpServer } from "@mcpjam/sdk";
import type { ProbeMcpServerResult } from "@mcpjam/sdk";
import {
  runDiscoveryPreflight,
  type DiscoveryOutcome,
} from "./server-connection-discovery.js";
import {
  acquireLease,
  fetchValidationContext,
  releaseLease,
  reportDiscovery,
  reportValidation,
  ServerConnectionBackendError,
} from "./server-connections-backend.js";
import { createPinnedFetch } from "../utils/pinned-fetch.js";

/** Bounds the authenticated initialize. Shorter than discovery's budget: by
 * this point we know the server answers, so a long hang is a fault rather than
 * a slow first contact. */
const VALIDATION_TIMEOUT_MS = 20_000;

export interface RunConnectionJobResult {
  requestId: string;
  ran: boolean;
  /** Why nothing ran, when nothing ran. Not an error — a lease refusal is the
   * lease doing its job. */
  skipped?: "not-leased" | "not-actionable";
  status?: string;
}

/**
 * Advance one request by one step.
 *
 * Never throws for an ordinary outcome. The caller is an HTTP route that has
 * already answered 202, so an exception here would land in a log with nobody
 * to read it; a failure the backend should know about is REPORTED to the
 * backend instead, which is what moves the request forward.
 */
export async function runConnectionJob(
  requestId: string
): Promise<RunConnectionJobResult> {
  const leaseId = randomUUID();

  const lease = await acquireLease(requestId, leaseId);
  if (!lease.leased) {
    return { requestId, ran: false, skipped: "not-leased" };
  }

  try {
    if (lease.status === "discovering") {
      await runDiscoveryStep(requestId, leaseId, lease.serverUrl ?? "");
      return { requestId, ran: true, status: lease.status };
    }

    if (lease.status === "validating") {
      await runValidationStep(requestId, leaseId);
      return { requestId, ran: true, status: lease.status };
    }

    // Anything else is waiting on a person, not on us.
    await releaseLease(requestId, leaseId);
    return { requestId, ran: false, skipped: "not-actionable" };
  } catch (error) {
    // The lease is released by whichever report ran; if we got here, none did.
    await releaseLease(requestId, leaseId).catch(() => {});
    if (error instanceof ServerConnectionBackendError) {
      // The row moved underneath us, or someone else owns it now. Both are
      // normal races, not faults.
      if (error.isConflict || error.isGone) {
        return { requestId, ran: false, skipped: "not-leased" };
      }
    }
    throw error;
  }
}

async function runDiscoveryStep(
  requestId: string,
  leaseId: string,
  serverUrl: string
): Promise<void> {
  const outcome: DiscoveryOutcome = await runDiscoveryPreflight({ serverUrl });

  if (outcome.kind === "discovered") {
    await reportDiscovery({
      requestId,
      leaseId,
      authMethod: outcome.authMethod,
    });
    return;
  }

  if (outcome.kind === "terminal") {
    // A blocked target or a non-MCP endpoint. `unsupported` is the backend's
    // terminal discovery arm, and it carries its own error code.
    await reportDiscovery({ requestId, leaseId, authMethod: "unsupported" });
    return;
  }

  // Retryable: the machine keeps the request in place and schedules another
  // attempt. Reported through the validation channel because that is where the
  // retry taxonomy lives.
  await reportValidation({
    requestId,
    leaseId,
    outcome: "retryable",
    errorCode: "VALIDATION_FAILED",
    errorMessage: outcome.detail,
  }).catch(async () => {
    // `reportValidation` is only legal from `validating`. A request still in
    // `discovering` cannot take it, so release the lease and let the retry cron
    // bring the request back around.
    await releaseLease(requestId, leaseId).catch(() => {});
  });
}

/**
 * Prove the connection works, with the credential the user authorized.
 *
 * An `initialize` handshake is the whole test, and it is the right one: it is
 * exactly what every later tool call has to do first, so a server that
 * initializes is a server the product can actually use.
 */
async function runValidationStep(
  requestId: string,
  leaseId: string
): Promise<void> {
  const context = await fetchValidationContext(requestId, leaseId);

  if (!context.serverUrl) {
    await reportValidation({
      requestId,
      leaseId,
      outcome: "terminal",
      errorCode: "PROTOCOL_VALIDATION_FAILED",
      errorMessage: "The connection request has no server URL to validate.",
    });
    return;
  }

  if (context.authMethod === "oauth" && !context.accessToken) {
    // Authorized, but nothing came back from the credential store. Sending the
    // user back to consent is the only thing that can fix it.
    await reportValidation({
      requestId,
      leaseId,
      outcome: "authentication-failed",
      errorCode: "AUTHENTICATION_FAILED",
      errorMessage: "No stored credential was found for this server.",
    });
    return;
  }

  const result = await attemptInitialize(
    context.serverUrl,
    context.accessToken
  );

  await reportValidation({
    requestId,
    leaseId,
    outcome: result.outcome,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  });
}

interface InitializeAttempt {
  outcome: "ready" | "authentication-failed" | "retryable" | "terminal";
  errorCode?: string;
  errorMessage?: string;
}

/** The stored grant was not accepted. Only a fresh consent changes this. */
const AUTHENTICATION_FAILED: InitializeAttempt = {
  outcome: "authentication-failed",
  errorCode: "AUTHENTICATION_FAILED",
  errorMessage:
    "The server rejected the stored credential. Authorizing again should fix it.",
};

/** It answered, and what it said was not MCP. Retrying replays the same answer. */
const NOT_AN_MCP_SERVER: InitializeAttempt = {
  outcome: "terminal",
  errorCode: "PROTOCOL_VALIDATION_FAILED",
  errorMessage:
    "The server responded, but not as a Model Context Protocol server.",
};

/** We learned nothing about the target. Keep the credential, come back. */
const COULD_NOT_CONNECT: InitializeAttempt = {
  outcome: "retryable",
  errorCode: "VALIDATION_FAILED",
  errorMessage: "Could not complete an authenticated connection.",
};

/**
 * The probe attempts that speak for the TARGET.
 *
 * `resource_metadata` and `authorization_server_metadata` are OAuth-discovery
 * calls that routinely hit a different host, so a 403 from one of those says
 * nothing about whether our credential was accepted by the MCP server — reading
 * it as an auth verdict would throw away a working grant over someone else's
 * misconfigured metadata endpoint.
 */
const TARGET_ATTEMPT_NAMES = new Set([
  "streamable_initialize",
  "sse_probe",
]) as ReadonlySet<string>;

/** Every HTTP status the target itself returned, oldest first. */
function targetResponseStatuses(probe: ProbeMcpServerResult): number[] {
  const statuses: number[] = [];
  for (const attempt of probe.transport.attempts) {
    if (!TARGET_ATTEMPT_NAMES.has(attempt.name)) continue;
    const status = attempt.response?.status;
    if (typeof status === "number") statuses.push(status);
  }
  return statuses;
}

function isCredentialRejection(statuses: readonly number[]): boolean {
  return statuses.some((status) => status === 401 || status === 403);
}

async function attemptInitialize(
  serverUrl: string,
  accessToken: string | null
): Promise<InitializeAttempt> {
  // The SAME pinned transport discovery uses. Validation dials the same
  // attacker-supplied hostname, and a guard that covered only the
  // unauthenticated probe would leave the authenticated call — the one carrying
  // a bearer token — on the unpinned path.
  const pinnedFetch = createPinnedFetch({ timeoutMs: VALIDATION_TIMEOUT_MS });

  try {
    const probe = await probeMcpServer({
      url: serverUrl,
      accessToken: accessToken ?? undefined,
      fetchFn: pinnedFetch,
      timeoutMs: VALIDATION_TIMEOUT_MS,
      clientName: "mcpjam-connection-validator",
      // No retry policy: the state machine owns retries, with its own budget
      // and backoff. A second retry loop in here would multiply against it and
      // burn the job budget five times faster than intended.
      retryPolicy: undefined,
    });

    // EXHAUSTIVE OVER THE PROBE'S UNION, ON PURPOSE. The first cut of this
    // branched on `probe.status === "ok"` — a value `probeMcpServer` cannot
    // return — so every successful validation fell through to the generic
    // retryable arm and no connection could ever reach `ready`. The `default`
    // below makes the next such drift a typecheck failure instead of a
    // feature that silently never completes.
    const statuses = targetResponseStatuses(probe);

    switch (probe.status) {
      // The probe only says `ready` when a handshake actually completed: a 2xx
      // whose body parsed as an MCP initialize result (streamable-http), or a
      // 2xx `text/event-stream` (SSE). Do NOT additionally require
      // `initialize.protocolVersion` — the SSE arm reports only a content type,
      // so demanding a version here would permanently mislabel every SSE server
      // as non-MCP.
      case "ready":
        return { outcome: "ready" };

      // A 401 with a challenge. We sent the stored credential, so this is the
      // server telling us that credential is not accepted.
      case "oauth_required":
        return AUTHENTICATION_FAILED;

      // NOT a success — the name is about the socket, not the protocol. Either
      // a 2xx whose body was not an initialize result, or a non-2xx the probe
      // did not judge transient (403 lands here, since 401 became
      // `oauth_required` above).
      case "reachable":
        return isCredentialRejection(statuses) || probe.oauth?.required === true
          ? AUTHENTICATION_FAILED
          : NOT_AN_MCP_SERVER;

      // No usable answer: DNS, TLS, connect, timeout, or a 5xx that kept
      // repeating.
      case "error":
        return classifyInitializeFailure(
          new Error(
            probe.error ?? "The connection attempt did not reach the server."
          ),
          statuses
        );

      default: {
        const exhaustive: never = probe.status;
        return {
          ...COULD_NOT_CONNECT,
          errorMessage: `Unrecognized probe status: ${String(exhaustive)}`,
        };
      }
    }
  } catch (error) {
    return classifyInitializeFailure(error);
  }
}

/**
 * Turn a connection failure into the machine's taxonomy.
 *
 * Deliberately conservative about `terminal`: a request that fails terminally
 * cannot be retried at all, so anything ambiguous is treated as retryable and
 * allowed to burn an attempt instead. The cost of a wrong `retryable` is a few
 * seconds; the cost of a wrong `terminal` is telling a user their working
 * server is broken.
 *
 * STRUCTURED EVIDENCE OUTRANKS PROSE. `transportStatuses` are codes the target
 * actually sent; `error.message` is a sentence assembled for a human, and it can
 * carry an incidental "401" or "forbidden" from a URL, an echoed header, or the
 * server's own error body. Matching that text over a status code we hold would
 * revoke a working grant because of a substring. The regex is therefore the
 * fallback for the case where there is no status at all — DNS, TLS, connect and
 * timeout failures never produce one — and not a second opinion.
 */
function classifyInitializeFailure(
  error: unknown,
  transportStatuses: readonly number[] = []
): InitializeAttempt {
  if (isCredentialRejection(transportStatuses)) {
    return AUTHENTICATION_FAILED;
  }

  const message = error instanceof Error ? error.message : String(error);

  // Nothing answered, so the message is the only evidence there is.
  if (
    transportStatuses.length === 0 &&
    /\b401\b|\b403\b|unauthorized|forbidden/i.test(message)
  ) {
    return AUTHENTICATION_FAILED;
  }

  // The endpoint answered, but not as MCP. Retrying an endpoint that speaks the
  // wrong protocol changes nothing, so this is the one confidently terminal arm.
  if (
    /not a valid|invalid.*(json-?rpc|protocol)|unsupported protocol version|parse error/i.test(
      message
    )
  ) {
    return NOT_AN_MCP_SERVER;
  }

  return COULD_NOT_CONNECT;
}
