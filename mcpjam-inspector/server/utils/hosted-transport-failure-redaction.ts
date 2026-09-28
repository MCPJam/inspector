/**
 * Decide what a failed HOSTED dial may say about its target, at the one point
 * where "did the target answer?" is still a fact rather than a guess: the fetch.
 *
 * WHY AT THE TRANSPORT. Conformance suites record the raw thrown value on every
 * failed check (`failedResult(..., errorDetails)`), and the SDK's `deepJsonSafe`
 * serializes an `Error` WITH its `cause` chain and its own enumerable fields. A
 * hosted run is persisted and read back by the caller, so without this:
 *
 *   - a REFUSAL carries its `cause` into the report. The egress guard keeps the
 *     address a hostname resolved to on `cause` precisely so it reaches logs
 *     and nothing else (`BlockedEgressTargetError`), and the pinned transport's
 *     original error names it too. Persisting the cause turns a refusal back
 *     into the resolution oracle the verdict's wording was written to avoid;
 *   - a socket, TLS or DNS failure keeps its own text — `ECONNREFUSED`, a TLS
 *     record error, a timeout — which is the open-versus-closed differential
 *     the hosted doctor already strips (`hosted-doctor-redaction.ts`).
 *
 * Deciding afterwards, over a finished report, would mean pattern-matching
 * error spellings; deciding here is structural. A fetch that RESOLVED handed
 * back a response from a host the guard allowed, and that response is the
 * diagnostic the product exists to show, so it passes untouched. A fetch that
 * REJECTED never got a response, so whatever its error says can only describe
 * a refusal, a socket, TLS or DNS — and is reduced before any suite sees it:
 *
 *   - the guard's refusal keeps its verdict and loses its `cause`. The verdict
 *     names only the host the caller (or the target's redirect) chose, never
 *     what it resolved to, which is what makes it safe to show;
 *   - the caller's OWN cancellation passes through unchanged — it describes our
 *     deadline, not the target, and the OAuth suite tells it apart by name;
 *   - everything else becomes the doctor's uniform message, with no code, no
 *     address and no cause.
 *
 * A no-op outside hosted mode, like the doctor's redaction: locally the socket
 * error is the answer, and a developer whose server is not running needs to
 * be told `ECONNREFUSED`.
 */

import { HOSTED_MODE } from "../config.js";
import { HOSTED_TRANSPORT_FAILURE_DETAIL } from "./hosted-doctor-redaction.js";
import { BlockedEgressTargetError } from "./hosted-egress-guard.js";

/**
 * The caller's own cancellation: an aborted signal, or a signal's timeout. Its
 * message describes our deadline, and the only `cause` it can carry is the
 * reason the CALLER aborted with.
 */
function isCallerCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function reduceTransportFailure(error: unknown): unknown {
  if (isCallerCancellation(error)) return error;
  if (error instanceof BlockedEgressTargetError) {
    // A fresh instance rather than a mutated one: the original is the same
    // object the guard may still be logging, and its `cause` belongs there.
    return new BlockedEgressTargetError(error.message);
  }
  return new Error(HOSTED_TRANSPORT_FAILURE_DETAIL);
}

/**
 * Wrap `fetchFn` so a rejection can only say what is safe to persist.
 *
 * Responses are returned untouched, body and all. `hosted` defaults to
 * `HOSTED_MODE`; pass it explicitly in tests.
 */
export function redactHostedTransportFailures(
  fetchFn: typeof fetch,
  options: { hosted?: boolean } = {},
): typeof fetch {
  const hosted = options.hosted ?? HOSTED_MODE;
  if (!hosted) return fetchFn;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await fetchFn(input, init);
    } catch (error) {
      throw reduceTransportFailure(error);
    }
  }) as typeof fetch;
}
