/**
 * The pinned transport's error class, in its own module.
 *
 * It lives apart from `oauth-proxy.ts` only so that `oauth/pinned-dns.ts` — the
 * shared DNS half that `oauth-proxy.ts` itself imports — can throw it without
 * an import cycle. `oauth-proxy.ts` re-exports the symbol, so every existing
 * `import { OAuthProxyError } from "./oauth-proxy.js"` keeps working and
 * `instanceof` keeps meaning one class.
 */
export class OAuthProxyError extends Error {
  status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

/**
 * What a proxy route says when the server it reached presented a certificate
 * Node.js would not accept. The describer and the OAuth debugger recognize
 * the failure by this sentence, so it is written once, here.
 */
export const TLS_TRUST_FAILURE =
  "The server's TLS certificate could not be verified";

/**
 * Node's X509 verification codes (the `tls` docs' "X509 certificate error
 * codes"), minus the CRL checks Node does not run by default and
 * `OUT_OF_MEM`, plus Node's own hostname check.
 */
const TLS_TRUST_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * A certificate-verification failure as a 502: the upstream answered the
 * handshake with a certificate we could not trust. Node's own text follows the
 * sentence because it carries the fix (`--use-system-ca` on recent versions).
 *
 * Only for a caller that knows the request went to the server under test. The
 * same codes on MCPJam's own hops mean something else (an expired certificate
 * of ours, or a TLS-inspecting proxy in front of the user), which is why the
 * describer keys off the sentence and never off the code.
 */
export function tlsTrustFailure(error: unknown): OAuthProxyError | undefined {
  const certificateError = findInCauseChain(error, (candidate) =>
    TLS_TRUST_CODES.has(codeOf(candidate) ?? "")
  );
  if (!certificateError) return undefined;
  return new OAuthProxyError(
    502,
    `${TLS_TRUST_FAILURE}: ${certificateError.message}`,
    { cause: error }
  );
}

/**
 * What a proxy route says when the connection to the server under test was
 * refused, reset, timed out or had no route. Recognized by this sentence, like
 * {@link TLS_TRUST_FAILURE}.
 */
export const UNREACHABLE_TARGET_FAILURE = "The connection to the server failed";

const UNREACHABLE_TARGET_ADVICE =
  "Check that the server is running and reachable from this machine.";

/** Node's errnos for a connection that never produced a response. */
const UNREACHABLE_TARGET_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

const MAX_LISTED_ATTEMPTS = 3;

/**
 * The debugger keeps the first 300 characters of a proxy's reason
 * (`MAX_PROXY_ERROR_CHARS` in the inspector's debug-state-machine-adapter), so
 * Node's detail gets only what the sentence, the advice and the hint leave.
 */
const MAX_REASON_CHARS = 300;

/**
 * A connection to the server under test that failed before any response, as
 * a 502, or a 504 when every attempt timed out. Node's text follows the
 * sentence because it names the address actually dialled; `hint` is the
 * caller's advice for where it runs. Only for a caller that knows the request
 * went to the server under test, for the same reason as {@link tlsTrustFailure}.
 *
 * A name with several addresses fails as an `AggregateError` with an empty
 * message and the FIRST attempt's code, so the attempts are read one by one: a
 * dead IPv6 address in front of a refused IPv4 one is a refusal, not a timeout.
 */
export function unreachableTargetFailure(
  error: unknown,
  hint?: string
): OAuthProxyError | undefined {
  const failed = findInCauseChain(error, (candidate) =>
    attemptsOf(candidate).some((attempt) =>
      UNREACHABLE_TARGET_CODES.has(codeOf(attempt) ?? "")
    )
  );
  if (!failed) return undefined;
  const attempts = attemptsOf(failed);
  const timedOut = attempts.every((attempt) => codeOf(attempt) === "ETIMEDOUT");
  const detail =
    failed.message ||
    attempts
      .slice(0, MAX_LISTED_ATTEMPTS)
      .map((attempt) => attempt.message)
      .join("; ");
  const head = `${UNREACHABLE_TARGET_FAILURE}: `;
  const tail = `. ${UNREACHABLE_TARGET_ADVICE}${hint ? ` ${hint}` : ""}`;
  const room = Math.max(MAX_REASON_CHARS - head.length - tail.length, 1);
  return new OAuthProxyError(
    timedOut ? 504 : 502,
    `${head}${detail.length > room ? `${detail.slice(0, room - 1)}…` : detail}${tail}`,
    { cause: error }
  );
}

/** One error per address Node tried, or the error itself. */
function attemptsOf(error: Error): Error[] {
  return error instanceof AggregateError
    ? error.errors.filter(
        (attempt): attempt is Error => attempt instanceof Error
      )
    : [error];
}

function codeOf(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The error in the `cause` chain that `matches`, so its message (Node's)
 * survives the wrappers above it. Bounded at the same depth as
 * `extractNodeErrno`, against cyclic chains.
 */
function findInCauseChain(
  error: unknown,
  matches: (candidate: Error) => boolean,
  depth = 0
): Error | undefined {
  if (!(error instanceof Error) || depth > 3) return undefined;
  if (matches(error)) return error;
  return findInCauseChain(error.cause, matches, depth + 1);
}

/**
 * Whether a message carries {@link tlsTrustFailure}'s sentence. A substring
 * match: the OAuth debugger wraps the proxy's reason in each step's own text
 * (`Failed to request MCP server: …`, discovery's `<url> failed: …`).
 */
export function isTlsTrustFailure(message: string): boolean {
  return message.includes(TLS_TRUST_FAILURE);
}

/** {@link isTlsTrustFailure} for {@link unreachableTargetFailure}'s sentence. */
export function isUnreachableTargetFailure(message: string): boolean {
  return message.includes(UNREACHABLE_TARGET_FAILURE);
}
