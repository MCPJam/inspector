const STORAGE_KEY = "webmcp:last-url";
export const DEFAULT_WEBMCP_URL = "http://localhost:3000";

/** Last page the inspector opened or was looking at. */
export function readLastWebMcpUrl(): string {
  if (typeof window === "undefined") return DEFAULT_WEBMCP_URL;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)?.trim();
    return raw || DEFAULT_WEBMCP_URL;
  } catch {
    return DEFAULT_WEBMCP_URL;
  }
}

/** Remember a URL. Blank values are ignored so a clear cannot wipe the last page. */
export function writeLastWebMcpUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // Private mode or quota — the in-memory field still works.
  }
}

export const WEBMCP_LAST_URL_KEY = STORAGE_KEY;
