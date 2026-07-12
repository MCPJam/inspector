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

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(
      "Client ID metadata URL must not contain a userinfo component"
    );
  }

  if (parsedUrl.hash || clientIdMetadataUrl.includes("#")) {
    throw new Error(
      "Client ID metadata URL must not contain a fragment component"
    );
  }

  // Detect dot segments on the RAW string: new URL() collapses them, which
  // would silently change the client identity before we could reject it.
  const rawWithoutQuery = clientIdMetadataUrl.split(/[?#]/, 1)[0];
  const authorityStart = rawWithoutQuery.indexOf("//") + 2;
  const pathStart = rawWithoutQuery.indexOf("/", authorityStart);
  const rawPath = pathStart === -1 ? "" : rawWithoutQuery.slice(pathStart);

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
