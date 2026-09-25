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
  url: string | null | undefined,
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
  b: string | null | undefined,
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
 * The pre-resolve form, for rows where whether a stored secret exists is only
 * known once it is resolved (XAA preregistered and DCR). Refuses a binding that
 * is recorded and names another origin; lets an unrecorded one through, because
 * a public client stores no secret and so is never bound. Whoever resolves the
 * secret must then call `assertSecretsOriginMatches` before spending it.
 */
export function assertRecordedSecretsOriginMatches(
  check: SecretOriginBindingCheck,
): void {
  if (typeof check.boundOrigin !== "string" || !check.boundOrigin.trim()) {
    return;
  }
  assertSecretsOriginMatches(check);
}

export function assertSecretsOriginMatches(
  check: SecretOriginBindingCheck,
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
    },
  );
}
