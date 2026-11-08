import type { Context } from "hono";
import { verifyAuthKitToken } from "./authkit-jwt.js";
import { validateToken } from "./session-token.js";
import { sandboxDigest } from "./sandbox-view-policy.js";
import { isAllowedRequestOrigin } from "../middleware/origin-validation.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

export function isSandboxWebRequest(c: Context): boolean {
  return c.req.path.startsWith("/api/web/");
}
export function localSandboxSession(c: Context): string | undefined {
  const value = c.req.header("X-MCP-Session-Auth");
  const token = value?.startsWith("Bearer ") ? value.slice(7) : undefined;
  return token && validateToken(token) ? token : undefined;
}
export async function sandboxViewOwner(
  c: Context,
  projectId?: string,
): Promise<string> {
  const localToken = isSandboxWebRequest(c)
    ? undefined
    : localSandboxSession(c);
  if (!isSandboxWebRequest(c) && !localToken)
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Sign in to prepare an App document.",
    );
  let actor = c.get("workosUserId") || c.get("guestId");
  let session = c.get("workosSessionId");
  if (!actor && isSandboxWebRequest(c)) {
    const token = (c.req.header("Authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    try {
      const verified = await verifyAuthKitToken(token, undefined, {
        allowMcpResourceAudience: true,
      });
      actor = verified.sub;
      session = verified.sid;
    } catch {
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Sign in to prepare an App document.",
      );
    }
  }
  if (!actor && !localToken)
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Sign in to prepare an App document.",
    );
  return sandboxDigest(
    JSON.stringify([
      actor ?? "local",
      session ?? null,
      localToken ? sandboxDigest(localToken) : null,
      projectId ?? null,
    ]),
  );
}
export function validateSandboxHostOrigin(c: Context, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "The App host origin is invalid.",
    );
  }
  if (
    parsed.origin !== origin ||
    !isAllowedRequestOrigin(origin) ||
    (c.req.header("Origin") && c.req.header("Origin") !== origin)
  )
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "This page cannot prepare an App document.",
    );
}
