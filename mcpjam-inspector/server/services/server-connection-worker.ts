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
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../utils/hosted-egress-guard.js";
import { logger } from "../utils/logger.js";

/** Bounds the authenticated initialize. Shorter than discovery's budget: by
 * this point we know the server answers, so a long hang is a fault rather than
 * a slow first contact. */
const VALIDATION_TIMEOUT_MS = 20_000;

/**
 * Bounds the whole STEP, which `VALIDATION_TIMEOUT_MS` does not.
 *
 * That value bounds one request and the probe makes several — initialize, an
 * SSE fallback, OAuth metadata — so a target that stalls each of them in turn
 * holds this request's work lease for the sum rather than for the timeout.
 * Discovery races its probe against a deadline for exactly this reason, and
 * validation dials the same attacker-supplied hostname.
 */
const VALIDATION_DEADLINE_MS = 45_000;

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
      // A lease in `discovering` with no URL is OUR contract broken, not a
      // verdict about the user's server. Passing `""` down made the guard throw
      // and the step report `authMethod: "unsupported"` — the terminal
      // discovery arm — which permanently tells someone their URL was refused
      // when the truth is that the backend handed us a row with nothing in it.
      if (!lease.serverUrl) {
        // Releasing the lease IS the remedy. A retryable report would be
        // accepted from `discovering`, but it would spend an authenticated
        // round trip to record OUR broken contract as the server's failure and
        // burn one of the request's attempts doing it. Let the retry cron
        // bring the row back around once the backend has something in it.
        logger.warn("Connection lease in `discovering` carried no server URL", {
          event: "server_connections.lease_missing_url",
          requestId,
        });
        await releaseLease(requestId, leaseId).catch(() => {});
        return { requestId, ran: false, skipped: "not-actionable" };
      }
      await runDiscoveryStep(requestId, leaseId, lease.serverUrl);
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
  // retry taxonomy lives — and a `retryable` report is legal from
  // `discovering`: the backend's retryable arm leaves the status alone and
  // only schedules the next attempt. NO catch here, deliberately. An earlier
  // revision swallowed every failure of this call on the belief that the
  // backend would refuse it, which also swallowed a genuine backend outage —
  // the caller's error path releases the lease and surfaces the failure, which
  // is where a 500 belongs.
  await reportValidation({
    requestId,
    leaseId,
    outcome: "retryable",
    errorCode: "VALIDATION_FAILED",
    errorMessage: outcome.detail,
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
    if (context.credentialRetryable) {
      // The credential is still there; its authorization server just could not
      // be reached to refresh it. Consent cannot fix an outage, and asking for
      // it anyway spends one of the request's three OAuth attempts — so a few
      // minutes of tenant downtime would fail the request outright.
      await reportValidation({
        requestId,
        leaseId,
        outcome: "retryable",
        errorCode: "VALIDATION_FAILED",
        errorMessage: "Could not reach the authorization server.",
      });
      return;
    }
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

/**
 * It refused an ANONYMOUS connection — and we had no credential to offer,
 * because discovery concluded it wanted none.
 *
 * A 401 or 403 is only evidence that a STORED GRANT was rejected if a stored
 * grant was actually sent. When none was, `authentication-failed` would be
 * actively wrong rather than merely imprecise: it moves the request to
 * `awaiting_authorization`, and a request whose discovered auth method is
 * `none` has no authorization server to send anyone to, so it would sit in a
 * state whose next step cannot be performed.
 *
 * `UNSUPPORTED_AUTH_METHOD` is the frozen code for "wants authentication this
 * flow cannot negotiate", which is precisely the contradiction: the server
 * demands credentials while advertising no challenge discovery could act on.
 */
const REFUSED_ANONYMOUS_CONNECTION: InitializeAttempt = {
  outcome: "terminal",
  errorCode: "UNSUPPORTED_AUTH_METHOD",
  errorMessage:
    "The server refused an unauthenticated connection but advertised no authentication method MCPJam can negotiate.",
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
  accessToken: string | null,
  deadlineMs: number = VALIDATION_DEADLINE_MS
): Promise<InitializeAttempt> {
  // The SAME pinned transport discovery uses. Validation dials the same
  // attacker-supplied hostname, and a guard that covered only the
  // unauthenticated probe would leave the authenticated call — the one carrying
  // a bearer token — on the unpinned path.
  const pinnedFetch = createPinnedFetch({ timeoutMs: VALIDATION_TIMEOUT_MS });

  // Whether we had anything to be rejected. A 401 or 403 is only evidence that
  // a stored grant was refused if a stored grant was sent; without one it means
  // the server refuses anonymous callers, which is a different verdict with a
  // different next step.
  const sentCredential = Boolean(accessToken);

  /**
   * THE PROBE SWALLOWS WHAT `fetchFn` THROWS. It catches every transport error
   * and reports `status: "error"`, which classifies as retryable — right for a
   * timeout and wrong for an egress refusal, because it would put an SSRF
   * attempt on a retry schedule with a live credential attached. Catching the
   * refusal around `probeMcpServer` does not help: it never gets that far.
   *
   * So the guard's verdict is recorded on the way past, exactly as
   * `server-connection-discovery.ts` does, and consulted before the probe's own
   * account of what happened.
   */
  const refusal: { blocked: BlockedEgressTargetError | null } = {
    blocked: null,
  };
  /** Set when the step deadline fires. The probe cannot be cancelled — its
   * config takes no abort signal — so this stops the NEXT hop instead, which is
   * what keeps a credential-bearing request from outliving the lease that
   * authorized it. */
  let expired = false;

  const guardedFetch: typeof fetch = async (target, init) => {
    if (expired) {
      throw new Error("The validation deadline passed before this request.");
    }
    try {
      return await pinnedFetch(target, init);
    } catch (error) {
      if (error instanceof BlockedEgressTargetError) {
        refusal.blocked = error;
      }
      throw error;
    }
  };

  /** A recorded refusal OUTRANKS every retryable outcome, so this is consulted
   * before each of them rather than only on the happy path. */
  const refusalOutcome = (): InitializeAttempt | null =>
    refusal.blocked === null
      ? null
      : {
          outcome: "terminal",
          errorCode: "URL_NOT_ALLOWED",
          errorMessage: refusal.blocked.message,
        };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(() => {
        expired = true;
        resolve("deadline");
      }, deadlineMs);
    });

    const raced = await Promise.race([
      probeMcpServer({
        url: serverUrl,
        accessToken: accessToken ?? undefined,
        fetchFn: guardedFetch,
        timeoutMs: VALIDATION_TIMEOUT_MS,
        clientName: "mcpjam-connection-validator",
        // No retry policy: the state machine owns retries, with its own budget
        // and backoff. A second retry loop in here would multiply against it and
        // burn the job budget five times faster than intended.
        retryPolicy: undefined,
      }),
      deadline,
    ]);

    if (raced === "deadline") {
      // The in-flight request cannot be cancelled — `ProbeMcpServerConfig`
      // takes no abort signal — but `expired` stops the probe from opening
      // another, so the credential-bearing traffic ends here rather than
      // continuing under a lease we are about to release. A refusal recorded
      // before the stall still decides the outcome; one arriving after is lost,
      // and that is a cost rather than a hole, since the guard refused the hop
      // either way and nothing was reached.
      return (
        refusalOutcome() ?? {
          ...COULD_NOT_CONNECT,
          errorMessage: `The connection attempt did not finish within ${deadlineMs}ms.`,
        }
      );
    }
    const probe = raced;

    // Before the probe's own account of what happened: it reports a refused
    // target as an ordinary transport error, which would read as retryable.
    const recorded = refusalOutcome();
    if (recorded !== null) return recorded;

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

      // A 401 with a challenge. If we sent the stored credential, this is the
      // server rejecting it. If we had none to send — discovery said the server
      // wanted none — then it is refusing anonymous callers instead, and the
      // two need different next steps.
      case "oauth_required":
        return sentCredential
          ? AUTHENTICATION_FAILED
          : REFUSED_ANONYMOUS_CONNECTION;

      // NOT a success — the name is about the socket, not the protocol. Either
      // a 2xx whose body was not an initialize result, or a non-2xx the probe
      // did not judge transient (403 lands here, since 401 became
      // `oauth_required` above).
      case "reachable":
        if (isCredentialRejection(statuses) || probe.oauth?.required === true) {
          return sentCredential
            ? AUTHENTICATION_FAILED
            : REFUSED_ANONYMOUS_CONNECTION;
        }
        return NOT_AN_MCP_SERVER;

      // No usable answer: DNS, TLS, connect, timeout, or a 5xx that kept
      // repeating.
      case "error":
        return classifyInitializeFailure(
          new Error(
            probe.error ?? "The connection attempt did not reach the server."
          ),
          statuses,
          sentCredential
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
    // The `instanceof` inside `classifyInitializeFailure` covers a refusal that
    // escapes the probe; `refusalOutcome` covers the ordinary case where the
    // probe swallowed it. Both paths exist because only the second one happens.
    return (
      refusalOutcome() ?? classifyInitializeFailure(error, [], sentCredential)
    );
  } finally {
    // Otherwise the pending timer keeps the event loop alive for the full
    // deadline after an answer has already been returned.
    clearTimeout(deadlineTimer);
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
  transportStatuses: readonly number[] = [],
  sentCredential = true
): InitializeAttempt {
  // A REFUSED TARGET IS TERMINAL, and it must be recognized before anything
  // else. The pinned transport throws this for a private, reserved, or
  // otherwise disallowed address; discovery already treats it as terminal, and
  // letting it fall through to the generic arm here would put an SSRF attempt
  // back on a retry schedule from the validation side — the same hole
  // `pinned-fetch.ts` was fixed to close on the discovery side.
  if (error instanceof BlockedEgressTargetError) {
    return {
      outcome: "terminal",
      errorCode: "URL_NOT_ALLOWED",
      // The guard's message names the reason without echoing anything a caller
      // could use to map the internal network.
      errorMessage: error.message,
    };
  }

  // DNS could not answer. Ours to retry, and emphatically not a verdict about
  // the user's server.
  if (error instanceof EgressResolutionError) {
    return { ...COULD_NOT_CONNECT, errorMessage: error.message };
  }

  if (isCredentialRejection(transportStatuses)) {
    return sentCredential ? AUTHENTICATION_FAILED : REFUSED_ANONYMOUS_CONNECTION;
  }

  const message = error instanceof Error ? error.message : String(error);

  // Nothing answered, so the message is the only evidence there is.
  if (
    transportStatuses.length === 0 &&
    /\b401\b|\b403\b|unauthorized|forbidden/i.test(message)
  ) {
    return sentCredential ? AUTHENTICATION_FAILED : REFUSED_ANONYMOUS_CONNECTION;
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
