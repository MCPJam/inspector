/**
 * Revoke, server-side, the AuthKit session this tab is signing out of.
 *
 * WorkOS's `signOut()` ends the session — no more refreshes — but cannot
 * recall the access tokens it already issued, and those stay valid in Convex
 * until they expire. So every sign-out first hands the token it is about to
 * discard to `/api/web/auth-session/revoke`, which records the session as
 * revoked; from then on Convex refuses any token from that session.
 *
 * BEST EFFORT, AND IT NEVER HOLDS SIGN-OUT HOSTAGE:
 *
 *  - Reading the token is bounded by {@link SIGN_OUT_REVOKE_TOKEN_TIMEOUT_MS}.
 *    It is normally already in memory; the bound only matters when authkit
 *    decides to refresh first and the network is slow.
 *  - The request is NOT awaited. It is sent with `keepalive`, so it outlives
 *    the navigation `signOut()` starts, and it goes to this origin so it needs
 *    no CORS preflight to do that.
 *  - Nothing here rejects. A tab with no session, a token that will not come,
 *    or a request that fails all just proceed to sign out.
 */

export const REVOKE_SESSION_PATH = "/api/web/auth-session/revoke";

/**
 * How long sign-out waits for the current access token before giving up on
 * revocation. INVARIANT, pinned by a test: this plus
 * `SIGN_OUT_REQUEST_TIMEOUT_MS` stays below `SIGN_OUT_SUPPRESSION_WINDOW_MS`
 * (see `sign-out-latch.ts`), so the slowest Electron sign-out still navigates
 * while the latch is held.
 */
export const SIGN_OUT_REVOKE_TOKEN_TIMEOUT_MS = 1_000;

type GetAccessToken = () => Promise<string | undefined | null>;

async function tokenWithin(
  getAccessToken: GetAccessToken,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      getAccessToken(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    // No session to read (already signed out, refresh refused): nothing to
    // revoke, and nothing to report — the caller is leaving either way.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start revoking the current session. Resolves once the request has been
 * handed to the browser (or revocation was skipped) — never rejects.
 */
export async function startSessionRevocation(
  getAccessToken: GetAccessToken,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const token = await tokenWithin(
    getAccessToken,
    options.timeoutMs ?? SIGN_OUT_REVOKE_TOKEN_TIMEOUT_MS,
  );
  if (!token) return;
  try {
    const send = options.fetchImpl ?? fetch;
    void send(REVOKE_SESSION_PATH, {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  } catch {
    // `fetch` missing or throwing synchronously — best effort, move on.
  }
}
