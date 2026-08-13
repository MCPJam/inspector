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

    if (probe.status === "ok" && probe.initialize?.protocolVersion) {
      return { outcome: "ready" };
    }

    // The probe reports an auth challenge rather than throwing, so the
    // credential case has to be read off the result, not caught.
    if (probe.oauth?.required === true) {
      return {
        outcome: "authentication-failed",
        errorCode: "AUTHENTICATION_FAILED",
        errorMessage:
          "The server rejected the stored credential. Authorizing again should fix it.",
      };
    }

    if (probe.status === "error" && probe.error) {
      return classifyInitializeFailure(new Error(probe.error));
    }

    return {
      outcome: "retryable",
      errorCode: "VALIDATION_FAILED",
      errorMessage: "Could not complete an authenticated connection.",
    };
  } catch (error) {
    return classifyInitializeFailure(error);
  }
}

/**
 * Turn a thrown connection failure into the machine's taxonomy.
 *
 * Deliberately conservative about `terminal`: a request that fails terminally
 * cannot be retried at all, so anything ambiguous is treated as retryable and
 * allowed to burn an attempt instead. The cost of a wrong `retryable` is a few
 * seconds; the cost of a wrong `terminal` is telling a user their working
 * server is broken.
 */
function classifyInitializeFailure(error: unknown): InitializeAttempt {
  const message = error instanceof Error ? error.message : String(error);

  // An auth rejection at initialize means the stored token is not accepted.
  if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) {
    return {
      outcome: "authentication-failed",
      errorCode: "AUTHENTICATION_FAILED",
      errorMessage:
        "The server rejected the stored credential. Authorizing again should fix it.",
    };
  }

  // The endpoint answered, but not as MCP. Retrying an endpoint that speaks the
  // wrong protocol changes nothing, so this is the one confidently terminal arm.
  if (
    /not a valid|invalid.*(json-?rpc|protocol)|unsupported protocol version|parse error/i.test(
      message
    )
  ) {
    return {
      outcome: "terminal",
      errorCode: "PROTOCOL_VALIDATION_FAILED",
      errorMessage:
        "The server responded, but not as a Model Context Protocol server.",
    };
  }

  return {
    outcome: "retryable",
    errorCode: "VALIDATION_FAILED",
    errorMessage: "Could not complete an authenticated connection.",
  };
}
