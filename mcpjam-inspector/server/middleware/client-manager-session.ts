import type { Context } from "hono";

export const MCPJAM_SESSION_COOKIE_NAME = "mcpjam_session_id";
export const MCPJAM_SESSION_HEADER_NAME = "x-mcpjam-session-id";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function resolveRequestSessionId(
  c: Context,
  hostedMode: boolean,
): string | undefined {
  if (!hostedMode) return undefined;

  const headerSessionId = normalizeSessionId(
    c.req.header(MCPJAM_SESSION_HEADER_NAME),
  );
  if (headerSessionId) return headerSessionId;

  const cookieSessionId = normalizeSessionId(
    getCookieValue(c.req.header("cookie"), MCPJAM_SESSION_COOKIE_NAME),
  );
  if (cookieSessionId) return cookieSessionId;

  const generatedSessionId = crypto.randomUUID();
  const secureSuffix = isSecureRequest(c) ? "; Secure" : "";
  const cookie = `${MCPJAM_SESSION_COOKIE_NAME}=${generatedSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secureSuffix}`;

  c.header("Set-Cookie", cookie, { append: true });
  return generatedSessionId;
}

function normalizeSessionId(rawValue: string | undefined): string | undefined {
  if (!rawValue) return undefined;
  const trimmed = rawValue.trim();
  if (!trimmed || !SESSION_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function getCookieValue(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader.split(";");
  for (const part of cookies) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== cookieName) continue;
    const rawValue = rest.join("=");
    if (!rawValue) return undefined;
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}

function isSecureRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto.toLowerCase().includes("https");
  }

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}
