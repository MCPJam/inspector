import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { ErrorCode } from "../routes/web/errors.js";
import {
  resolveSurfaceActingUser,
  SlackBackendUnavailable,
} from "../services/slack-backend.js";

export const SURFACE_TENANT_HEADER = "x-mcpjam-surface-tenant-id";
export const SURFACE_ACTOR_HEADER = "x-mcpjam-surface-actor-id";
export const DISCORD_TOKEN_PREFIX = "dsc_";

const SURFACE_ALLOWED_PATHS = [
  /^\/api\/surface-link\/session$/,
  /^\/api\/v1\/projects\/[^/]+\/agent$/,
  /^\/api\/v1\/projects$/,
  /^\/api\/v1\/projects\/[^/]+\/proposed-actions\/[^/]+\/execute$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/,
  /^\/api\/v1\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/steps$/,
];

function tokenHashMatches(token: string, envName: string): boolean {
  const configured = process.env[envName];
  if (!configured) return false;
  const left = createHash("sha256").update(token).digest("hex");
  const right = configured.trim().toLowerCase();
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function isDiscordServiceToken(token: string): boolean {
  return token.startsWith(DISCORD_TOKEN_PREFIX);
}

export function isValidDiscordServiceToken(token: string): boolean {
  return (
    isDiscordServiceToken(token) &&
    tokenHashMatches(token, "MCPJAM_DISCORD_SERVICE_TOKEN_HASH")
  );
}

/**
 * Discord's service-token gate.
 *
 * This function used to take a `surfaceKind` of `"discord" | "teams"` and
 * carry a whole second branch — including a `MCPJAM_TEAMS_SERVICE_TOKEN_HASH`
 * lookup that would activate a working auth path the moment someone set that
 * env var. There is no Teams client, no dispatch to it, and no test covering
 * it: a scaffold that only ever behaved as attack surface. It is gone.
 *
 * `"teams"` deliberately stays in the type unions on `types/hono.ts` and
 * `services/slack-backend.ts` — those describe the BACKEND's contract, which
 * still knows the value, and churning them buys nothing. Re-adding the branch
 * when a Teams app actually exists is a small, deliberate change; leaving it
 * live for a client that may never arrive was not.
 */
export async function handleSurfaceServiceAuth(
  c: Context,
  token: string,
  surfaceKind: "discord"
): Promise<Response | null> {
  if (!isValidDiscordServiceToken(token))
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
      401
    );
  if (!SURFACE_ALLOWED_PATHS.some((pattern) => pattern.test(c.req.path)))
    return c.json(
      { code: ErrorCode.UNAUTHORIZED, message: "Invalid API key" },
      401
    );
  const tenantId = c.req.header(SURFACE_TENANT_HEADER)?.trim();
  const actorId = c.req.header(SURFACE_ACTOR_HEADER)?.trim();
  if (!tenantId || !actorId)
    return c.json(
      {
        code: ErrorCode.UNAUTHORIZED,
        message: `${SURFACE_TENANT_HEADER} and ${SURFACE_ACTOR_HEADER} are required.`,
      },
      401
    );
  let link: Awaited<ReturnType<typeof resolveSurfaceActingUser>>;
  try {
    link = await resolveSurfaceActingUser(surfaceKind, tenantId, actorId, {
      surfaceServiceToken: token,
    });
  } catch (error) {
    if (error instanceof SlackBackendUnavailable)
      return c.json(
        {
          code: ErrorCode.SERVER_UNREACHABLE,
          message: "Could not verify the surface account right now.",
        },
        503
      );
    throw error;
  }
  if (!link)
    return c.json(
      {
        code: ErrorCode.UNAUTHORIZED,
        message: "This surface account is not linked to MCPJam.",
      },
      401
    );
  c.set("authMethod", `${surfaceKind}_service`);
  c.set("workosUserId", link.workosUserId);
  c.set("mcpjamUserId", link.userId);
  c.set("mcpjamOrganizationId", link.organizationId);
  c.set("surfaceKind", surfaceKind);
  c.set("surfaceTenantId", tenantId);
  c.set("surfaceActorId", actorId);
  return null;
}
