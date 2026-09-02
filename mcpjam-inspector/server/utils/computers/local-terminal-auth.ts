/**
 * Single-use handshake nonces for the LOCAL computer terminal WebSocket.
 *
 * Why a nonce at all: a browser cannot attach an `Authorization` header to a
 * WebSocket handshake, and a `?token=` query string lands in proxy/CDN access
 * logs — so the cloud terminal already puts its token in the
 * `Sec-WebSocket-Protocol` slot. The local terminal reuses that transport, but
 * there is no Convex-minted JWT to put there: this PTY is on the user's own
 * machine and no control plane knows about it.
 *
 * So the mint route (`POST /api/mcp/computers/local-terminal-token`, which sits
 * behind the inspector session token + a VERIFIED sign-in + a non-guest check +
 * server-verified local consent) issues one of these, and the WS handler
 * consumes it. Properties that matter:
 *
 *  - In-memory only. It never outlives the process that minted it, and a
 *    second inspector cannot redeem another's nonce.
 *  - SINGLE USE. Consuming removes it, so a nonce leaked into a log or a
 *    replayed handshake buys nothing after the legitimate connect.
 *  - Short TTL (60s) — a handshake follows its mint immediately.
 *  - Bound to the validated project key, so a nonce minted for one project's
 *    workspace can't open a PTY in another's.
 *  - Constant-time compare on the lookup key, so redemption cannot be turned
 *    into a timing oracle for guessing 32 random bytes.
 *
 * The nonce is base64url so it is a valid `Sec-WebSocket-Protocol` token
 * (RFC 6455 restricts that header to HTTP tokens — base64 padding/`+`/`/`
 * would not survive).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { validateLocalProjectKey } from "./local-machine.js";

export const LOCAL_TERMINAL_NONCE_TTL_MS = 60_000;

/** Backstop against unbounded growth if something mints in a loop. Exported so
 *  the eviction test derives its bounds from the source of truth. */
export const MAX_OUTSTANDING_NONCES = 64;

interface IssuedNonce {
  nonce: string;
  projectId: string;
  expiresAtMs: number;
  /**
   * Fingerprint of the consent capability this nonce was minted against. The
   * TTL alone would let a nonce outlive the consent that authorized it: revoke
   * (or a re-grant from another profile, which ROTATES the capability) must
   * invalidate anything already handed out, so redemption re-checks this
   * against the live capability rather than trusting the 60s window.
   */
  consentFingerprint: string;
}

const outstanding: IssuedNonce[] = [];

function pruneExpired(now: number): void {
  for (let i = outstanding.length - 1; i >= 0; i -= 1) {
    const entry = outstanding[i];
    if (entry && entry.expiresAtMs <= now) outstanding.splice(i, 1);
  }
}

/**
 * Mint a single-use nonce for `projectId`. Throws if the project key isn't one
 * bounded path segment — the same validation the workspace resolver applies,
 * done HERE so an invalid key never reaches the WS handler at all.
 */
export function issueLocalTerminalNonce(
  projectId: string,
  consentFingerprint: string
): {
  nonce: string;
  expiresAtMs: number;
} {
  const validated = validateLocalProjectKey(projectId);
  if (!consentFingerprint) {
    throw new Error("A consent capability is required to mint a terminal nonce.");
  }
  const now = Date.now();
  pruneExpired(now);
  // Drop the oldest rather than refuse: a legitimate user reconnecting in a
  // tight loop must never be locked out by their own stale nonces.
  while (outstanding.length >= MAX_OUTSTANDING_NONCES) outstanding.shift();
  const nonce = randomBytes(32).toString("base64url");
  const expiresAtMs = now + LOCAL_TERMINAL_NONCE_TTL_MS;
  outstanding.push({
    nonce,
    projectId: validated,
    expiresAtMs,
    consentFingerprint,
  });
  return { nonce, expiresAtMs };
}

/**
 * Redeem a nonce. Returns the bound projectId and the consent fingerprint it was
 * minted against on success, `null` otherwise; either way the nonce is gone
 * afterwards. The CALLER must still check that fingerprint against the live
 * capability — see `IssuedNonce.consentFingerprint`.
 *
 * The scan is unconditional (no early exit) and compares with `timingSafeEqual`,
 * so a caller learns nothing from how long a rejection took.
 */
export function consumeLocalTerminalNonce(
  presented: string | null | undefined
): { projectId: string; consentFingerprint: string } | null {
  const now = Date.now();
  pruneExpired(now);
  if (typeof presented !== "string" || presented.length === 0) return null;
  const presentedBuf = Buffer.from(presented, "utf8");
  let matchIndex = -1;
  for (let i = 0; i < outstanding.length; i += 1) {
    const entry = outstanding[i];
    if (!entry) continue;
    const storedBuf = Buffer.from(entry.nonce, "utf8");
    const equal =
      storedBuf.length === presentedBuf.length &&
      timingSafeEqual(storedBuf, presentedBuf);
    if (equal && matchIndex === -1) matchIndex = i;
  }
  if (matchIndex === -1) return null;
  const [claimed] = outstanding.splice(matchIndex, 1);
  if (!claimed) return null;
  // Re-check the deadline on the CLAIMED entry: pruning ran before the compare,
  // and an entry that expires in between must not be honored.
  if (claimed.expiresAtMs <= Date.now()) return null;
  return {
    projectId: claimed.projectId,
    consentFingerprint: claimed.consentFingerprint,
  };
}

/** Test seam: the store is process-global. */
export function resetLocalTerminalNoncesForTests(): void {
  outstanding.length = 0;
}

/** Test/diagnostic helper: how many un-redeemed nonces are outstanding. */
export function outstandingLocalTerminalNonceCount(): number {
  pruneExpired(Date.now());
  return outstanding.length;
}
