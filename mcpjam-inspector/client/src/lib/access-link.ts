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
export function consumeAccessLinkFromUrl(): void {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (!hash.has("token")) return;
  const token = hash.get("token");
  if (isAccessToken(token)) rememberAccessToken(token);
  // Even malformed credentials must disappear before telemetry initializes.
  const tab = hash.get("tab");
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${
      tab ? `#${encodeURIComponent(tab)}` : ""
    }`,
  );
}
