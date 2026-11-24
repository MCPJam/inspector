/**
 * Which surface a call came through, for the record of who submitted a round.
 * The caller's name is the backend's (it comes from the credential); the
 * surface is what the call says about itself in `x-mcpjam-launcher`, so it is a
 * label and never decides what the caller may do.
 */
import type { PlatformClimbSubmittedVia } from "@mcpjam/sdk/platform";
import type { LaunchContext } from "../../utils/launch-context.js";

export function submittedViaOf(launch: LaunchContext | undefined): PlatformClimbSubmittedVia {
  const kind = launch?.launcher?.kind;
  if (kind === "cli") return "cli";
  if (kind === "mcp") return "mcp";
  return "api";
}
