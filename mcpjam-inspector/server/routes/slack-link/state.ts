/**
 * Signed-state and CSRF helpers for the Slack account-link bridge.
 *
 * Generalized from `cli-auth/state.ts`: the same HMAC-signed, short-lived
 * envelope, but carrying a link-session id instead of a loopback redirect.
 *
 * There are TWO distinct secrets-shaped things here and conflating them is the
 * bug this module exists to prevent:
 *
 *   - The SIGNED STATE the bot puts in the URL it posts to Slack. It only
 *     needs integrity (nobody may swap in another session id), so it is an
 *     HMAC over `{linkSessionId, exp}`. It is NOT a secret: anyone in the
 *     Slack conversation can read it, which is exactly why the flow demands
 *     an identity proof rather than treating URL possession as authorization.
 *
 *   - The per-leg OAUTH STATES, one for Slack and one for WorkOS. These ARE
 *     secrets, held only in the browser's redirect chain, and only their
 *     SHA-256 hashes are persisted — so a database read cannot forge a
 *     callback. They must differ from each other: a single shared value would
 *     let a state observed on the first leg be replayed into the second,
 *     collapsing two independent CSRF defences into one.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ten minutes. The URL is posted into a Slack conversation where it persists
 * indefinitely, so the window in which it is worth anything must be small.
 */
export const SLACK_LINK_STATE_TTL_MS = 10 * 60 * 1000;

export interface SlackLinkStatePayload {
  /** The pending link session this URL belongs to. */
  linkSessionId: string;
  /** Expiry, milliseconds since epoch. */
  exp: number;
}

function hmac(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signSlackLinkState(
  payload: SlackLinkStatePayload,
  secret: string
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${body}.${hmac(body, secret).toString("base64url")}`;
}

export function verifySlackLinkState(
  token: string,
  secret: string,
  now: number = Date.now()
): SlackLinkStatePayload | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  const expected = hmac(body, secret);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.linkSessionId !== "string" ||
    record.linkSessionId.length === 0 ||
    typeof record.exp !== "number"
  ) {
    return null;
  }
  if (record.exp <= now) return null;

  return { linkSessionId: record.linkSessionId, exp: record.exp };
}

/** SHA-256 hex. Only hashes of the per-leg OAuth states are ever persisted. */
export function hashOauthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * Compare a presented OAuth state against its stored hash in constant time.
 * A plain `===` on the hashes leaks the divergence position through timing,
 * which is a (weak, but free to avoid) oracle for forging a callback.
 */
export function oauthStateMatches(
  presented: string,
  storedHash: string
): boolean {
  const left = Buffer.from(hashOauthState(presented), "utf8");
  const right = Buffer.from(storedHash, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 256 bits of entropy, URL-safe. Used for states, nonces, and session ids. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
