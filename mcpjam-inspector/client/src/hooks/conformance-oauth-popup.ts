/** Only web URLs may open the authorization popup. */
export function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** The OAuth popup, or null when the browser blocked it. */
export function openAuthorizationPopup(
  authorizationUrl: string,
): Window | null {
  return window.open(
    authorizationUrl,
    "oauth_conformance_auth",
    "width=600,height=700,scrollbars=yes"
  );
}
