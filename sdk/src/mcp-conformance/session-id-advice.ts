/**
 * The No Session Id advice (`readiness-no-session-id`).
 *
 * 2026-07-28 removed protocol-level sessions. For a server that still sends
 * `Mcp-Session-Id` it says: "An `Mcp-Session-Id` header on a request: ignore
 * it, and do not mint or echo session IDs" (streamable-http.mdx:686-692). That
 * is a SHOULD, so such a server is advised here and never failed: check 35
 * (`modern-no-session-id`) passes either way and lists the ids it saw.
 *
 * Its own module because `readiness.ts` is at the size budget. The outcomes
 * have the same shape the helpers there build.
 */

import { READINESS_CATALOG } from "../conformance-catalog.js";
import {
  jsonRpcResult,
  modernHeaders,
  modernRequestBody,
  rawRequest,
  type RawHttpResult,
} from "./raw-http.js";
import type { MCPReadinessOutcome, RawHttpCheckContext } from "./types.js";

const ID = "readiness-no-session-id";

/**
 * What the advice says about one `server/discover` answer.
 *
 * `undefined` when the answer carries no JSON-RPC result: a refused or failed
 * exchange is not one the server served as a session, so its headers say
 * nothing either way.
 */
export function noSessionIdOutcome(
  result: RawHttpResult
): MCPReadinessOutcome | undefined {
  if (jsonRpcResult(result) === undefined) return undefined;
  const title = READINESS_CATALOG[ID].title;
  const sessionId = result.headers["mcp-session-id"];
  if (sessionId === undefined) {
    return { id: ID, title, specStrength: "SHOULD" };
  }
  return {
    id: ID,
    title,
    severity: "warning",
    specStrength: "SHOULD",
    message: `The server sent an Mcp-Session-Id header (${JSON.stringify(sessionId)}) with its server/discover result. 2026-07-28 has no protocol-level sessions, and the spec says a server SHOULD not mint or echo session ids`,
    details: { sessionId },
  };
}

/**
 * One answer is read, the `server/discover` one, which the run sends without
 * a session id: a header on it was minted.
 */
export async function noSessionIdAdvice(
  ctx: RawHttpCheckContext
): Promise<MCPReadinessOutcome | undefined> {
  if (ctx.config.era !== "modern") {
    // The 2025 revisions have sessions.
    return undefined;
  }
  const version = ctx.config.protocolVersion ?? "2026-07-28";
  // The runner already asked on a raw-only pin; otherwise ask once here.
  const result =
    ctx.discover ??
    (await rawRequest(ctx, {
      headers: modernHeaders({
        protocolVersion: version,
        method: "server/discover",
      }),
      body: modernRequestBody({
        id: 9403,
        method: "server/discover",
        protocolVersion: version,
      }),
      timeoutMs: Math.min(ctx.config.checkTimeout, 5_000),
    }));
  return noSessionIdOutcome(result);
}
