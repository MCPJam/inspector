// Keep this module dependency-free: main consumes the fragment before loading
// the app, analytics, error reporting, or any OAuth modules.
export const LOCAL_ACCESS_KEY = "mcpjam.local-access";
export const ACCESS_REQUIRED_EVENT = "mcpjam:access-required";
export const ACCESS_GRANTED_EVENT = "mcpjam:access-granted";
let accessToken: string | null = null;
export const isAccessToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{24,}$/.test(value);
export function rememberAccessToken(token: string): void {
  accessToken = token;
  try {
    localStorage.setItem(LOCAL_ACCESS_KEY, token);
  } catch {}
}
export function readAccessToken(preferStorage = false): string | null {
  if (!preferStorage && accessToken) return accessToken;
  try {
    const saved = localStorage.getItem(LOCAL_ACCESS_KEY);
    if (isAccessToken(saved)) return saved;
  } catch {}
  return accessToken;
}
export function parseAccessLink(value: string): string | null {
  if (isAccessToken(value.trim())) return value.trim();
  try {
    const token = new URLSearchParams(new URL(value.trim()).hash.slice(1)).get(
      "token",
    );
    return isAccessToken(token) ? token : null;
  } catch {
    return null;
  }
}
export const ACCESS_LINK_RECEIVED_EVENT = "mcpjam:access-link-received";
/** Returns the credential it saved, or null when the URL carried none. */
export function consumeAccessLinkFromUrl(): string | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (!hash.has("token")) return null;
  const token = hash.get("token");
  const accepted = isAccessToken(token) ? token : null;
  if (accepted) rememberAccessToken(accepted);
  // Even malformed credentials must disappear before telemetry initializes.
  const tab = hash.get("tab");
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${
      tab ? `#${encodeURIComponent(tab)}` : ""
    }`,
  );
  return accepted;
}
/**
 * A link pasted into the address bar of an open tab only changes the fragment,
 * so the page does not reload and startup never sees it. Registered before
 * error reporting installs its own popstate listener, so navigation
 * breadcrumbs record the scrubbed URL.
 */
export function watchForAccessLinks(): () => void {
  const receive = () => {
    if (consumeAccessLinkFromUrl())
      window.dispatchEvent(new Event(ACCESS_LINK_RECEIVED_EVENT));
  };
  window.addEventListener("popstate", receive);
  window.addEventListener("hashchange", receive);
  return () => {
    window.removeEventListener("popstate", receive);
    window.removeEventListener("hashchange", receive);
  };
}
