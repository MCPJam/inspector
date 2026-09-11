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
 * Strip the open-versus-closed differential out of a HOSTED doctor result.
 *
 * WHAT THIS IS FOR. The pinned transport above stops the private target being
 * REACHED. It does not, on its own, stop the attempt describing what it found:
 * `normalizeServerDoctorError` copies the raw transport message onto
 * `connection.detail`, `checks.connection.detail` and `error.message`, and the
 * probe copies it onto `attempts[].error`. Those four fields are the residue.
 *
 * THE TEST IS STRUCTURAL, NOT A PATTERN LIST. A denylist of socket-error
 * spellings leaks the first time undici renames one. Instead: if NO probe
 * attempt received a response, then nothing HTTP-level happened, so every one
 * of those strings can only be describing a socket, DNS or TLS outcome — and it
 * is replaced wholesale. Once some attempt has a response the target answered
 * as a public host, and its detail is the diagnostic the product exists to
 * show, so it passes through untouched.
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
        attempts?: Array<{ response?: unknown; error?: string }>;
      };
    } | null;
    connection?: { status?: string; detail?: string };
    checks?: Record<string, { status?: string; detail?: string } | undefined>;
    error?: { message?: string } | null;
  };

  const attempts = envelope.probe?.transport?.attempts ?? [];
  if (attempts.some((attempt) => attempt?.response !== undefined)) {
    return result;
  }

  const rewrite = (detail: string | undefined): string | undefined =>
    detail === undefined || isEgressRefusalDetail(detail)
      ? detail
      : HOSTED_TRANSPORT_FAILURE_DETAIL;

  for (const attempt of attempts) {
    if (attempt?.error !== undefined) {
      attempt.error = rewrite(attempt.error);
    }
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
    envelope.error.message = rewrite(envelope.error.message);
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
