/**
 * Signed-state helpers for the hosted CLI OAuth bridge (`/api/cli/auth/*`).
 *
 * The hosted routes exist because WorkOS AuthKit redirect URIs are registered
 * statically, while the CLI listens on an ephemeral loopback port. `/start`
 * binds the CLI's loopback redirect + state into an HMAC-signed, short-lived
 * token that rides through AuthKit as the OAuth `state`; `/callback` verifies
 * it before forwarding the authorization code to the loopback. The signature
 * is what prevents the callback from being used as an open redirect.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CLI_AUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface CliAuthStatePayload {
  /** The CLI's loopback redirect target, validated by isAllowedLoopbackRedirect. */
  cliRedirectUri: string;
  /** The CLI's own opaque state, echoed back on the loopback redirect. */
  cliState: string;
  /** Expiry, milliseconds since epoch. */
  exp: number;
}

function hmac(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signCliAuthState(
  payload: CliAuthStatePayload,
  secret: string
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${body}.${hmac(body, secret).toString("base64url")}`;
}

export function verifyCliAuthState(
  token: string,
  secret: string,
  now: number = Date.now()
): CliAuthStatePayload | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
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
    typeof record.cliRedirectUri !== "string" ||
    typeof record.cliState !== "string" ||
    typeof record.exp !== "number"
  ) {
    return null;
  }
  if (record.exp <= now) {
    return null;
  }
  if (!isAllowedLoopbackRedirect(record.cliRedirectUri)) {
    return null;
  }

  return {
    cliRedirectUri: record.cliRedirectUri,
    cliState: record.cliState,
    exp: record.exp,
  };
}

/**
 * Only plain-http loopback targets may receive the authorization code. This
 * is the open-redirect guard: hostname must be EXACTLY `127.0.0.1` or
 * `localhost` (no suffix-matching tricks like `127.0.0.1.evil.com`, which
 * parse to a different hostname), and embedded credentials are rejected.
 */
export function isAllowedLoopbackRedirect(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    return false;
  }
  if (parsed.username || parsed.password) {
    return false;
  }
  return true;
}
