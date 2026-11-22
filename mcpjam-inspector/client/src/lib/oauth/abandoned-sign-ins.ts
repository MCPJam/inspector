export const ABANDONED_SIGN_IN_MESSAGE =
  "This sign-in was canceled or timed out. Reconnect the server to sign in again.";

// The issued `state` of each sign-in the app stopped waiting for (cancel or
// timeout). Its browser tab stays open and can still finish, and without this
// its callback would either find no pending key and vanish, or complete
// against the newer attempt that now owns the key.
const abandonedStates = new Set<string>();

/** Call before the attempt's storage is cleared: the state is read from it. */
export function rememberAbandonedSignIn(serverName: string): void {
  const state = localStorage.getItem(`mcp-oauth-issued-state-${serverName}`);
  if (state) abandonedStates.add(state);
}

/** True once for a callback whose sign-in was abandoned. */
export function takeAbandonedSignIn(state: string | null): boolean {
  return state !== null && abandonedStates.delete(state);
}
