export const ABANDONED_SIGN_IN_MESSAGE =
  "This sign-in was canceled or timed out. Reconnect the server to sign in again.";

export const REPLACED_SIGN_IN_MESSAGE =
  "This sign-in was replaced by a newer one. Finish that one in your browser.";

// The issued `state` of each sign-in the app stopped waiting for (cancel or
// timeout), the same value a callback must match to own its attempt. The
// browser tab stays open and can still finish. Kept in localStorage so the
// notice survives a renderer reload, and bounded so tabs that never return do
// not pile up.
const STORAGE_KEY = "mcp-oauth-abandoned-sign-ins";
const MAX_ENTRIES = 20;
const RETENTION_MS = 24 * 60 * 60 * 1000;

type AbandonedSignIn = { state: string; at: number };

function readEntries(now: number): AbandonedSignIn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    // A corrupt record costs only the late-callback notice.
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is AbandonedSignIn =>
      typeof entry?.state === "string" &&
      typeof entry?.at === "number" &&
      now - entry.at < RETENTION_MS,
  );
}

function writeEntries(entries: AbandonedSignIn[]): void {
  if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** Call before the attempt's storage is cleared: the state is read from it. */
export function rememberAbandonedSignIn(serverName: string): void {
  const state = localStorage.getItem(`mcp-oauth-issued-state-${serverName}`);
  if (!state) return;
  const now = Date.now();
  const entries = readEntries(now).filter((entry) => entry.state !== state);
  writeEntries([...entries, { state, at: now }].slice(-MAX_ENTRIES));
}

/** True once for a callback whose sign-in was abandoned. */
export function takeAbandonedSignIn(state: string | null): boolean {
  if (state === null) return false;
  const entries = readEntries(Date.now());
  const remaining = entries.filter((entry) => entry.state !== state);
  writeEntries(remaining);
  return remaining.length !== entries.length;
}
