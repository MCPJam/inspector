/**
 * Client Identifier URL validation per draft-ietf-oauth-client-id-metadata-document-02.
 *
 * Client Identifier URLs are compared with simple string comparison (RFC 3986
 * section 6.2.1), so validation MUST NOT normalize the input: `:443`, percent
 * escaping, and other distinguishable spellings are distinct client
 * identities. The validated original string is returned unchanged.
 */
/** RFC 8252 loopback hosts (for the gated local-dev CIMD carve-out). */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "127.0.0.1" ||
    h === "::1"
  );
}

export function validateClientIdMetadataUrl(
  clientIdMetadataUrl: string,
  options: { allowLoopback?: boolean } = {}
): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(clientIdMetadataUrl);
  } catch {
    throw new Error("Client ID metadata URL must be a valid absolute URL");
  }

  // Standards require HTTPS. `allowLoopback` (an explicit, local-dev-only opt-in)
  // additionally permits http:// to a loopback host so a locally-run reflector
  // can be exercised end-to-end; it never affects public/remote URLs.
  const loopbackHttp =
    options.allowLoopback === true &&
    parsedUrl.protocol === "http:" &&
    isLoopbackHost(parsedUrl.hostname);

  if (!loopbackHttp && (parsedUrl.protocol !== "https:" || !parsedUrl.hostname)) {
    throw new Error("Client ID metadata URL must be an absolute HTTPS URL");
  }

  // The Client Identifier URL is compared by simple string equality and we
  // return it unchanged, so a spelling WHATWG would transport-normalize makes
  // fetch request a different URL than the identity string. Reject the
  // structural cases below. This is NOT exhaustive over every WHATWG
  // normalization — host lowercasing, percent-encoding, and IDNA/Unicode host
  // normalization are out of scope for these draft-02 structural checks:
  //  - not an `https://` prefix with exactly two slashes (rejects single-slash
  //    `https:/…` and backslash scheme `https:\…`). The scheme is matched
  //    case-insensitively — RFC 3986 schemes are case-insensitive and the case
  //    doesn't change which host fetch contacts, so `HTTPS://` is allowed.
  if (!loopbackHttp && !/^https:\/\//i.test(clientIdMetadataUrl)) {
    throw new Error(
      "Client ID metadata URL must use the https:// scheme (with two slashes)"
    );
  }
  //  - ASCII controls (0x00–0x1F), space (0x20), DEL (0x7F), and backslashes:
  //    WHATWG strips tabs/newlines/leading-trailing controls and percent-encodes
  //    spaces, and treats backslashes as slashes — each changes the URL fetch
  //    actually uses.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(clientIdMetadataUrl)) {
    throw new Error(
      "Client ID metadata URL must not contain control characters, whitespace, or backslashes"
    );
  }

  if (parsedUrl.hash || clientIdMetadataUrl.includes("#")) {
    throw new Error(
      "Client ID metadata URL must not contain a fragment component"
    );
  }

  // Parse the authority and path off the RAW string. new URL() collapses dot
  // segments and normalizes an empty userinfo away — either would silently
  // change the client identity before we could reject it. The guards above
  // guarantee an `https://` prefix (any case) with no backslashes, so a plain
  // split is sufficient here.
  const rawWithoutQuery = clientIdMetadataUrl.split(/[?#]/, 1)[0];
  const afterScheme = rawWithoutQuery.replace(/^https:\/\//i, "");
  const slashIndex = afterScheme.indexOf("/");
  const rawAuthority =
    slashIndex === -1 ? afterScheme : afterScheme.slice(0, slashIndex);
  const rawPath = slashIndex === -1 ? "" : afterScheme.slice(slashIndex);

  // Extra slashes after `https://` (e.g. `https:///host`, `https:////host`)
  // leave the authority empty in the raw string while new URL() promotes the
  // next token to the hostname — so fetch would hit a host the identity string
  // doesn't name. Reject an empty authority.
  if (!rawAuthority) {
    throw new Error(
      "Client ID metadata URL must contain a host immediately after https://"
    );
  }

  // Userinfo: the parsed check catches any NON-empty spelling (WHATWG populates
  // username even for non-canonical forms), while the raw `@` scan catches the
  // EMPTY spelling `https://@host` that leaves username/password as "" (falsy).
  if (parsedUrl.username || parsedUrl.password || rawAuthority.includes("@")) {
    throw new Error(
      "Client ID metadata URL must not contain a userinfo component"
    );
  }

  // Require a path component. A root path ("/") is permitted — draft-02 §3
  // marks it NOT RECOMMENDED, not invalid — so only reject a genuinely absent
  // path.
  if (!rawPath) {
    throw new Error("Client ID metadata URL must contain a path component");
  }

  // WHATWG dot-segment detection decodes %2e (any case) first: "%2e%2e",
  // "%2e.", ".%2e" all collapse like "..". Match that so an encoded spelling
  // can't slip past what the parser would normalize away.
  const isDotSegment = (segment: string) => {
    const normalized = segment.replace(/%2e/gi, ".");
    return normalized === "." || normalized === "..";
  };
  if (rawPath.split("/").some(isDotSegment)) {
    throw new Error(
      "Client ID metadata URL must not contain single-dot or double-dot path segments"
    );
  }

  // A query component is SHOULD NOT in the draft, not MUST NOT: accept it.

  return clientIdMetadataUrl;
}
