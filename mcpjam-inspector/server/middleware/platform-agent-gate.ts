import type { Context, Next } from "hono";
import { ErrorCode, webError } from "../routes/web/errors.js";
import { isPlatformAgentEnabled } from "../utils/platform-agent.js";

/**
 * Every agent route's answer while `MCPJAM_PLATFORM_AGENT=off`. Mounted ahead
 * of authentication, so nothing behind it runs: no token is checked, no MCP
 * manager is built, and no agent server is dialled.
 */
export async function platformAgentGate(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (isPlatformAgentEnabled()) return next();
  return webError(
    c,
    404,
    ErrorCode.FEATURE_NOT_SUPPORTED,
    "Ask MCPJam is turned off on this deployment. Ask your administrator to turn it on.",
    { reason: "platform_agent_off" },
  );
}
