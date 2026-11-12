import { Hono } from "hono";
import {
  readRequestJson,
  reportRouteFailure,
} from "../../utils/route-error-report.js";
import {
  parseLocalConnectRequestBody,
  readAuthorizedStdioLaunchSpec,
  respondWithLocalRouteError,
} from "../../utils/local-server-resolver.js";
import {
  checkStdioLaunchApproval,
  stdioCommandApprovalTerms,
  stdioLaunchFingerprint,
  toStdioLaunchSpec,
} from "../../utils/stdio-command-approvals.js";
import { STDIO_COMMAND_APPROVAL_REQUIRED_REASON } from "../../../shared/stdio-command-approval.js";
import { WebRouteError } from "../web/errors.js";

export const commandApprovalReview = new Hono();

// Reviewing fresh, authorized terms must neither approve nor start the command.
commandApprovalReview.post("/", async (c) => {
  let body: unknown;
  try {
    body = await readRequestJson(c);
  } catch {
    return c.json(
      { error: "The command review request was invalid. Try again." },
      400,
    );
  }
  const parsed = parseLocalConnectRequestBody(c, body);
  if (!parsed.ok) return respondWithLocalRouteError(c, parsed.error);
  const { projectId, serverId, serverDisplayName, bearer } = parsed.params;
  try {
    const launch = await readAuthorizedStdioLaunchSpec({
      bearerToken: bearer,
      projectId,
      serverId,
      serverDisplayName,
    });
    const spec = toStdioLaunchSpec({ ...launch, cwd: launch.workingDirectory });
    const { approval, changedEnvNames } = await checkStdioLaunchApproval(
      serverId,
      spec,
    );
    if (approval === "approved") return c.json({ approved: true });
    return c.json({
      reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
      approval: stdioCommandApprovalTerms({
        serverId,
        spec,
        fingerprint: stdioLaunchFingerprint(spec),
        approval,
        changedEnvNames,
      }),
    });
  } catch (error) {
    if (error instanceof WebRouteError)
      return respondWithLocalRouteError(c, error);
    reportRouteFailure("Failed to review server command", error, {
      source: "mcp.servers.command-approval",
      hop: "mcpjam_internal",
    });
    return c.json(
      { error: "The command could not be reviewed. Try again." },
      500,
    );
  }
});
