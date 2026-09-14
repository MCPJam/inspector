/**
 * The last gate before a stored credential goes on the wire (MJ-003).
 *
 * A saved server row holds the target `url` and the credentials entered for it.
 * Revealing those credentials is creator-only; changing the `url` needs only
 * workspace role `member`. The backend now clears the credentials when a `url`
 * change crosses their origin, which closes the reported attack — but two gaps
 * survive a write-side fix alone, and this is what covers them:
 *
 *   1. **The authorize/reveal window.** Authorize and reveal are separate round
 *      trips. A `url` flipped between them is read by the first and paid for by
 *      the second, and no write-side gate can see that.
 *   2. **The next writer.** Three code paths patch an existing row's `url`
 *      today. A fourth added later without the gate reopens the finding; this
 *      refuses to attach the credential anyway.
 *
 * ON-ROW CREDENTIALS ONLY. `secretsBoundOrigin` is the binding for what the row
 * itself stores — the secret headers, the stdio env, the XAA client secret and
 * the DCR registration — and the backend writes it for exactly that set
 * (`serverRowHoldsStoredCredential` in `convex/lib/serverSecretOrigin.ts`, which
 * the backfill reuses to pick its rows). A stored hosted OAuth token is NOT in
 * that set: it lives per subject in `hostedOAuthCredentials` with its own
 * `serverUrl`, so an OAuth-only row has no `secretsBoundOrigin` at all and
 * gating one on this field would refuse every such connection. Those tokens are
 * refused backend-side instead, at the single resolve chokepoint every connect
 * path goes through (`internalResolveHostedOAuthAccessToken`), which answers
 * `oauthUnavailableReason: 'credential_origin_mismatch'` in place of the token.
 *
 * STDIO HAS NO ORIGIN, so it has no binding and is not gated here. Its `env`
 * reaches a locally spawned child rather than a remote host, and the repoint
 * that redirects it — a `command`/`args` swap — is a write-side trigger the
 * backend owns (`stdioTargetChangeRedirectsCredentials`). Treating "no origin"
 * as "no binding, refuse" would break every local stdio server.
 *
 * FAIL CLOSED, INCLUDING ON ABSENCE. An http row about to spend an on-row
 * credential with no recorded binding is refused, not allowed. "Absent means
 * allow" is the hole the field exists to close, and it is why the backend's
 * `secretsBoundOrigin` backfill gates this deploy: enforcement must not ship
 * until every credential-bearing row is bound, or existing servers stop
 * connecting.
 *
 * The origin rules are a hand-mirror of `convex/lib/canonicalUrl.ts`
 * (`originForCredentialBinding`). They have to agree: a stricter rule here
 * refuses connections the backend considers fine, and a looser one accepts a
 * credential the backend would have cleared. Change one, change both.
 */

import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

/**
 * The http(s) origin a credential is bound to: scheme + host + non-default
 * port. `null` for anything that cannot be reduced to one.
 *
 * A trailing dot is stripped because `host.example.com.` and `host.example.com`
 * are the same name to a resolver and different strings to a comparison — the
 * same reason `hosted-egress-guard.ts` strips it before judging a host. Without
 * that, one host presents as two origins.
 *
 * Non-http schemes are rejected rather than passed through: `URL.origin`
 * answers the opaque string `"null"` for them, which would compare equal
 * between two unrelated `file:` or `data:` URLs.
 */
export function originForCredentialBinding(
  url: string | null | undefined
): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = host;
  return parsed.origin;
}

/** Do these two values name the same credential-binding origin? */
export function sameCredentialBindingOrigin(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = originForCredentialBinding(a);
  const right = originForCredentialBinding(b);
  if (left === null || right === null) return false;
  return left === right;
}

export interface SecretOriginBindingCheck {
  /** The origin the credentials were saved against, from authorize or reveal. */
  boundOrigin: string | null | undefined;
  /** The URL this connection is about to open. */
  targetUrl: string | null | undefined;
  /** For the error message, so a user knows which server to fix. */
  serverName?: string;
}

/**
 * Refuse to attach a stored credential whose bound origin does not match the
 * URL it is about to be sent to.
 *
 * Throws rather than silently dropping the credential. A silent drop connects
 * unauthenticated, which surfaces as a confusing upstream 401 and hides an
 * attack in progress — the operator sees "the server rejected us" when what
 * happened is "somebody moved your server and we declined to hand over your
 * token". The message has to say that, because re-entering the credential is
 * the only way forward.
 */
export function assertSecretsOriginMatches(
  check: SecretOriginBindingCheck
): void {
  if (sameCredentialBindingOrigin(check.boundOrigin, check.targetUrl)) {
    return;
  }

  const targetOrigin = originForCredentialBinding(check.targetUrl);
  const named = check.serverName ? ` "${check.serverName}"` : "";
  // Classified, not echoed. A non-empty but unparseable binding is not "saved
  // for <that string>" — it is a binding nobody can act on, which is the same
  // situation as an unrecorded one and needs the same instruction. Reporting it
  // as a valid origin sends an operator looking for a host that does not exist,
  // and puts an unvalidated stored value into an error message on the way.
  const boundOrigin = originForCredentialBinding(check.boundOrigin);
  const boundTo = boundOrigin
    ? `saved for ${boundOrigin}`
    : "not recorded against any origin";

  throw new WebRouteError(
    403,
    ErrorCode.FORBIDDEN,
    `Server${named} now points at ${
      targetOrigin ?? "an unusable URL"
    }, but its saved credentials were ${boundTo}. ` +
      `They were not sent. Re-enter this server's credentials for the new URL.`,
    {
      secretOriginMismatch: true,
      boundOrigin,
      targetOrigin,
    }
  );
}
