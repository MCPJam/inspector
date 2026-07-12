/**
 * Client Identifier URL validation per draft-ietf-oauth-client-id-metadata-document-02.
 *
 * Client Identifier URLs are compared with simple string comparison (RFC 3986
 * section 6.2.1), so validation MUST NOT normalize the input: `:443`, percent
 * escaping, and other distinguishable spellings are distinct client
 * identities. The validated original string is returned unchanged.
 */
export function validateClientIdMetadataUrl(
  clientIdMetadataUrl: string
): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(clientIdMetadataUrl);
  } catch {
    throw new Error("Client ID metadata URL must be a valid absolute URL");
  }

  if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname) {
    throw new Error("Client ID metadata URL must be an absolute HTTPS URL");
  }

  if (parsedUrl.hash || clientIdMetadataUrl.includes("#")) {
    throw new Error(
      "Client ID metadata URL must not contain a fragment component"
    );
  }

  // Parse the authority and path off the RAW string. new URL() both collapses
  // dot segments and normalizes an empty userinfo away — either would silently
  // change the client identity (Client Identifier URLs compare by simple
  // string equality) before we could reject it. Normalize the scheme prefix
  // the way WHATWG does for special schemes (backslashes act as slashes; any
  // number of slashes may follow the scheme) so a non-canonical spelling can't
  // hide the authority from this scan.
  const rawWithoutQuery = clientIdMetadataUrl.split(/[?#]/, 1)[0];
  const afterScheme = rawWithoutQuery
    .replace(/\\/g, "/")
    .replace(/^https:\/*/i, "");
  const slashIndex = afterScheme.indexOf("/");
  const rawAuthority =
    slashIndex === -1 ? afterScheme : afterScheme.slice(0, slashIndex);
  const rawPath = slashIndex === -1 ? "" : afterScheme.slice(slashIndex);

  // Userinfo: the parsed check catches any NON-empty spelling (WHATWG populates
  // username even for non-canonical forms like `https:/user@host`), while the
  // raw `@` scan catches the EMPTY spelling `https://@host` that leaves
  // username/password as "" (falsy). Both are needed.
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

  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(
      "Client ID metadata URL must not contain single-dot or double-dot path segments"
    );
  }

  // A query component is SHOULD NOT in the draft, not MUST NOT: accept it.

  return clientIdMetadataUrl;
}
