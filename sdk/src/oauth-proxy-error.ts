/**
 * The pinned transport's error class, in its own module.
 *
 * It lives apart from `oauth-proxy.ts` only so that `oauth/pinned-dns.ts` — the
 * shared DNS half that `oauth-proxy.ts` itself imports — can throw it without
 * an import cycle. `oauth-proxy.ts` re-exports the symbol, so every existing
 * `import { OAuthProxyError } from "./oauth-proxy.js"` keeps working and
 * `instanceof` keeps meaning one class.
 */
import { extractNodeErrno } from "./error-describer/node-errno.js";

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
  const code = extractNodeErrno(error);
  if (!(error instanceof Error) || !code || !TLS_TRUST_CODES.has(code)) {
    return undefined;
  }
  const reason =
    error.cause instanceof Error && extractNodeErrno(error.cause) === code
      ? error.cause.message
      : error.message;
  return new OAuthProxyError(502, `${TLS_TRUST_FAILURE}: ${reason}`, {
    cause: error,
  });
}

/**
 * Whether a message carries {@link tlsTrustFailure}'s sentence. A substring
 * match: the OAuth debugger wraps the proxy's reason in each step's own text
 * (`Failed to request MCP server: …`, discovery's `<url> failed: …`).
 */
export function isTlsTrustFailure(message: string): boolean {
  return message.includes(TLS_TRUST_FAILURE);
}
