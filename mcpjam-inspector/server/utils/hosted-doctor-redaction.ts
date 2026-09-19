/**
 * Strip the open-versus-closed differential out of a HOSTED doctor result.
 *
 * ITS OWN MODULE, and that is not tidiness. This is a pure function over an
 * envelope, but it used to live in `routes/web/servers.ts` — so a test for it
 * had to import the whole route, and the route's dependency graph grew until
 * that import alone blew a 30s test timeout. Nothing here needs a route.
 */

import { HOSTED_MODE } from "../config.js";

/**
 * One uniform message for every failure that never got an HTTP response.
 *
 * Deliberately says nothing about WHY. `connect ECONNREFUSED 127.0.0.1:6379`
 * and `tls_get_more_records:packet length too long` are the same fact to the
 * person debugging their own server — the inspector could not talk to it — and
 * two different facts to someone walking a port range, which is what made them
 * the finding's Scenario B port scanner.
 */
const HOSTED_TRANSPORT_FAILURE_DETAIL =
  "The inspector could not establish a connection to this server.";

/**
 * The one error code every redacted failure collapses to.
 *
 * `normalizeServerDoctorError` derives the code from the raw message by
 * substring, so the code is the message's oracle in miniature: a refused
 * connect matches `econn` and becomes `SERVER_UNREACHABLE`, an open cleartext
 * port's TLS record error matches nothing and becomes `INTERNAL_ERROR`, and a
 * filtered port times out and becomes `TIMEOUT`. Rewriting only the message
 * left those three outcomes as distinguishable as before.
 */
const HOSTED_TRANSPORT_FAILURE_CODE = "SERVER_UNREACHABLE";

/**
 * Strip the open-versus-closed differential out of a HOSTED doctor result.
 *
 * WHAT THIS IS FOR. The pinned transport above stops the private target being
 * REACHED. It does not, on its own, stop the attempt describing what it found:
 * `normalizeServerDoctorError` copies the raw transport message onto
 * `connection.detail`, `checks.connection.detail` and `error.message`, and the
 * probe copies it onto `attempts[].error`. OAuth discovery adds one more:
 * `oauth.discoveryError` is the failure of a fetch to a host the TARGET named
 * in its own `WWW-Authenticate` challenge, so it is a second origin, chosen
 * separately from the server URL, and the same port oracle pointed at it.
 * `bench-probe-child` copies that string onto a user-visible check detail.
 *
 * THE TEST IS STRUCTURAL, NOT A PATTERN LIST. A denylist of socket-error
 * spellings leaks the first time undici renames one. Instead: an attempt that
 * received no response got no further than the socket, so what it says can only
 * be describing a socket, DNS or TLS outcome — and it is replaced wholesale. An
 * attempt that did receive one reached a host answering as a public server, and
 * its detail is the diagnostic the product exists to show, so it passes through
 * untouched. That reasoning is per attempt, so the decision is too: a target
 * whose first transport answers and whose second is refused at the socket used
 * to have the second one's message pass through with the first's.
 *
 * THE ENVELOPE-LEVEL FIELDS TAKE THE STRICTER GATE. `probe.error`,
 * `connection.detail`, `checks[].detail`, `error` and `oauth.discoveryError`
 * summarise the whole run and name no attempt, so a mixed run cannot be
 * resolved per attempt and the summary may well be quoting the refused hop.
 * They survive only when every recorded attempt received a response AND the
 * doctor's connect leg did not fail. That second condition is not redundant:
 * the connect leg runs after the probe, records no attempt of its own, and
 * writes its raw transport error onto `connection.detail`,
 * `checks.connection.detail` and `error` — so a target that answers the probe
 * cleanly and then redirects the connect elsewhere had its socket outcome
 * reflected verbatim under an attempts-only test. A run that recorded no
 * attempt at all offers no proof either and is redacted with the rest.
 *
 * `error.code` GOES WITH `error.message`. It is derived from that message by
 * substring match, so leaving it behind kept the differential the message lost;
 * whenever the message is replaced the code collapses too.
 *
 * `attempts[].durationMs` IS THE SAME ORACLE WITH A STOPWATCH. A refused port
 * returns in about a millisecond and a filtered one burns the whole timeout, so
 * the number separates the outcomes the message no longer does. An attempt that
 * received a response keeps its real duration — the host is demonstrably open,
 * so the timing discloses nothing and is the latency figure the doctor exists
 * to report. An attempt whose error was replaced never got past the socket, so
 * it collapses to the 0 the probe already writes for an attempt it never
 * dialled.
 *
 * An egress refusal keeps its own message: `classifyPinnedTransportError`
 * already phrases it without the address the hostname resolved to, so it is a
 * verdict about the target rather than a resolution oracle, and telling someone
 * their URL is not publicly routable is the one detail that helps them.
 *
 * A no-op outside hosted mode. Locally the socket error is the answer — a
 * developer whose server is not running needs to be told `ECONNREFUSED`.
 */
export function redactHostedDoctorTransportDetail<T>(result: T): T {
  if (!HOSTED_MODE) return result;
  const envelope = result as {
    probe?: {
      status?: string;
      /**
       * The probe's OWN top-level error, distinct from the per-attempt ones:
       * `createProbeErrorResult` puts `error.message` here verbatim. Missing
       * this field left the whole redaction cosmetic — the attempt errors were
       * rewritten while the same socket text stayed one key higher up.
       */
      error?: string;
      transport?: {
        attempts?: Array<{
          response?: unknown;
          error?: string;
          durationMs?: number;
        }>;
      };
      oauth?: { discoveryError?: string };
    } | null;
    connection?: { status?: string; detail?: string };
    checks?: Record<string, { status?: string; detail?: string } | undefined>;
    error?: { code?: string; message?: string } | null;
  };

  const attempts = envelope.probe?.transport?.attempts ?? [];
  const answered = (attempt: { response?: unknown } | undefined) =>
    attempt?.response !== undefined;

  const rewrite = (detail: string | undefined): string | undefined =>
    detail === undefined || isEgressRefusalDetail(detail)
      ? detail
      : HOSTED_TRANSPORT_FAILURE_DETAIL;

  for (const attempt of attempts) {
    if (attempt?.error === undefined || answered(attempt)) continue;
    const redacted = rewrite(attempt.error);
    if (redacted === attempt.error) continue;
    attempt.error = redacted;
    attempt.durationMs = 0;
  }

  const everyAttemptAnswered = attempts.length > 0 && attempts.every(answered);
  const connectLegFailed = envelope.connection?.status === "error";
  if (everyAttemptAnswered && !connectLegFailed) {
    return result;
  }

  if (envelope.probe?.oauth?.discoveryError !== undefined) {
    envelope.probe.oauth.discoveryError = rewrite(
      envelope.probe.oauth.discoveryError
    );
  }
  if (envelope.probe?.error !== undefined) {
    envelope.probe.error = rewrite(envelope.probe.error);
  }
  if (envelope.connection?.status === "error") {
    envelope.connection.detail = rewrite(envelope.connection.detail);
  }
  for (const check of Object.values(envelope.checks ?? {})) {
    if (check?.status === "error") {
      check.detail = rewrite(check.detail);
    }
  }
  if (envelope.error?.message !== undefined) {
    const redacted = rewrite(envelope.error.message);
    if (redacted !== envelope.error.message) {
      envelope.error.message = redacted;
      envelope.error.code = HOSTED_TRANSPORT_FAILURE_CODE;
    }
  }
  return result;
}

/**
 * Is this detail the guard's own verdict rather than a socket outcome?
 *
 * Matched against the message `classifyPinnedTransportError` and
 * `hosted-egress-guard` produce — the only two places a refusal is worded — so
 * a reworded refusal degrades to the uniform message above rather than to a
 * leak. The regression test drives the real transport at a real reserved
 * address, so a rewording fails a test here instead of silently changing what
 * callers are told.
 */
function isEgressRefusalDetail(detail: string): boolean {
  return (
    /not a publicly routable address/i.test(detail) ||
    /private or internal address/i.test(detail)
  );
}
