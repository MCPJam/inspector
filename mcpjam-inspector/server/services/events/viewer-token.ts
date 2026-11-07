/**
 * Viewer tokens for the hosted events feed (contract C7).
 *
 * The inspector checks that the caller is a project member NOW, then issues a
 * short-lived token the browser presents to the inbox Worker's
 * `GET /i/{inboxId}/deliveries` and `/stream`. The Worker never sees a user
 * session: this token is its whole authorization, so it is scoped to one
 * inbox, read-only, and expires in at most ten minutes.
 *
 * Wire format — must stay byte-compatible with the Worker's verifier
 * (`mcpjam-backend/events-inbox/src/viewer-token.ts`):
 *
 *     v1.<b64url(payloadJson)>.<b64url(HMAC-SHA256(key, "v1." + b64url(payloadJson)))>
 *
 *   - `b64url` is RFC 4648 §5 base64url WITHOUT padding;
 *   - `key` is the UTF-8 bytes of `EVENTS_INBOX_VIEWER_KEY`, used as-is;
 *   - payload `{inboxId, projectId, userId, epoch, exp, scope: "feed:read"}`,
 *     serialized in exactly that key order, `exp` in Unix SECONDS.
 *
 * `epoch` is the inbox's current viewer epoch, read from the admin API
 * (`GET /admin/i/{inboxId}/viewer-epoch`; epochs start at 1). Bumping it
 * revokes every outstanding token at once. The pinned test vector in
 * `__tests__/viewer-token.test.ts` is the literal the Worker's tests mirror.
 */

import { createHmac } from "node:crypto";
import { getEventsInboxViewerKey } from "./config.js";

export const VIEWER_TOKEN_VERSION = "v1";
export const VIEWER_TOKEN_SCOPE = "feed:read";
/** C7: `exp ≤ 10 min` ahead of issue. */
export const MAX_VIEWER_TOKEN_TTL_SECONDS = 10 * 60;
/** Same floor as the Worker: a shorter key is treated as unconfigured. */
export const MIN_VIEWER_KEY_LENGTH = 32;

export interface ViewerTokenClaims {
  inboxId: string;
  projectId: string;
  userId: string;
  epoch: number;
  /** Expiry, Unix SECONDS. */
  exp: number;
  scope: typeof VIEWER_TOKEN_SCOPE;
}

export class ViewerTokenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerTokenConfigError";
  }
}

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Sign exact claims. Deterministic: the same key and claims always produce the
 * same token (pinned in the tests). Refuses an unconfigured key and a claim set
 * the Worker would refuse anyway.
 */
export function signViewerToken(claims: ViewerTokenClaims, key: string): string {
  if (!key || key.length < MIN_VIEWER_KEY_LENGTH) {
    throw new ViewerTokenConfigError(
      "EVENTS_INBOX_VIEWER_KEY is not configured (or shorter than 32 characters).",
    );
  }
  if (!claims.inboxId || !claims.projectId || !claims.userId) {
    throw new TypeError("Viewer token claims need inboxId, projectId and userId.");
  }
  if (!Number.isSafeInteger(claims.epoch) || !Number.isSafeInteger(claims.exp)) {
    throw new TypeError("Viewer token epoch and exp must be integers.");
  }
  if (claims.scope !== VIEWER_TOKEN_SCOPE) {
    throw new TypeError(`Viewer token scope must be "${VIEWER_TOKEN_SCOPE}".`);
  }
  // Explicit key order: the MAC covers the transmitted bytes, so the order is
  // not load-bearing for verification — but a deterministic token is what
  // lets both repos pin one literal.
  const payload = base64Url(
    Buffer.from(
      JSON.stringify({
        inboxId: claims.inboxId,
        projectId: claims.projectId,
        userId: claims.userId,
        epoch: claims.epoch,
        exp: claims.exp,
        scope: claims.scope,
      }),
      "utf8",
    ),
  );
  const signingInput = `${VIEWER_TOKEN_VERSION}.${payload}`;
  const mac = createHmac("sha256", Buffer.from(key, "utf8"))
    .update(signingInput, "utf8")
    .digest();
  return `${signingInput}.${base64Url(mac)}`;
}

/**
 * Issue a token for a member who was just checked. `ttlSeconds` above the C7
 * ceiling is refused here rather than silently clamped: a caller asking for a
 * longer token has misunderstood the contract.
 */
export function issueViewerToken(args: {
  inboxId: string;
  projectId: string;
  userId: string;
  epoch: number;
  ttlSeconds?: number;
  nowMs?: number;
  key?: string;
}): { token: string; expiresAt: number; claims: ViewerTokenClaims } {
  const ttlSeconds = args.ttlSeconds ?? MAX_VIEWER_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError("Viewer token TTL must be a positive whole number of seconds.");
  }
  if (ttlSeconds > MAX_VIEWER_TOKEN_TTL_SECONDS) {
    throw new RangeError(
      `Viewer tokens expire within ${MAX_VIEWER_TOKEN_TTL_SECONDS} seconds (C7).`,
    );
  }
  const key = args.key ?? getEventsInboxViewerKey();
  if (!key) {
    throw new ViewerTokenConfigError("EVENTS_INBOX_VIEWER_KEY is not configured.");
  }
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000);
  const claims: ViewerTokenClaims = {
    inboxId: args.inboxId,
    projectId: args.projectId,
    userId: args.userId,
    epoch: args.epoch,
    exp: nowSeconds + ttlSeconds,
    scope: VIEWER_TOKEN_SCOPE,
  };
  return {
    token: signViewerToken(claims, key),
    expiresAt: claims.exp * 1000,
    claims,
  };
}
