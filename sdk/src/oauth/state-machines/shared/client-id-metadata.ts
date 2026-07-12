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
  // string equality) before we could reject it.
  const rawWithoutQuery = clientIdMetadataUrl.split(/[?#]/, 1)[0];
  const authorityStart = rawWithoutQuery.indexOf("//") + 2;
  const pathStart = rawWithoutQuery.indexOf("/", authorityStart);
  const rawAuthority =
    pathStart === -1
      ? rawWithoutQuery.slice(authorityStart)
      : rawWithoutQuery.slice(authorityStart, pathStart);
  const rawPath = pathStart === -1 ? "" : rawWithoutQuery.slice(pathStart);

  // WHATWG URL sets username/password to "" for `https://@host` (both falsy),
  // so parsedUrl.username/password miss an empty-userinfo spelling. Inspect the
  // raw authority for the `@` delimiter to reject any userinfo, empty or not.
  if (rawAuthority.includes("@")) {
    throw new Error(
      "Client ID metadata URL must not contain a userinfo component"
    );
  }

  if (!rawPath || rawPath === "/") {
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
