import { Hono } from "hono";
import {
  localExecutionAuthorizationSchema,
  localExecutionTargetSchema,
} from "@mcpjam/sdk/platform";
import {
  parseWithSchema,
  readJsonBody,
  ErrorCode,
  WebRouteError,
} from "../web/errors.js";
import {
  LocalAutoApproveConsentRequiredError,
  LocalHarnessRefusalError,
  LOCAL_HARNESS_DISPLAY_NAMES,
  ensureLocalHarnessTarget,
  LocalRuntimePreparingError,
} from "../../utils/harness/local/readiness.js";
import { isLocalHarnessVenue } from "../../utils/harness/local/run-resources.js";
import { v1Error, v1Resource } from "./envelope.js";

const localExecution = new Hono();
localExecution.post(
  "/projects/:projectId/local-execution-grants",
  async (c) => {
    const input = parseWithSchema(
      localExecutionAuthorizationSchema,
      await readJsonBody(c),
    );
    const bearer = c.req.header("authorization") ?? "";
    if (!bearer)
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "A verified user bearer is required",
      );
    const name = LOCAL_HARNESS_DISPLAY_NAMES[input.harnessId];
    // The same venue gate local evals and swarms use: an unattended run the
    // product would refuse there (for Codex, a target its sandbox was not
    // measured on) is never started from the API either.
    if (!isLocalHarnessVenue(input.harnessId, "unattended"))
      return v1Error(
        c,
        "CONFLICT",
        `${name} can't run unattended on this computer. Run it in the cloud instead.`,
        { reason: "LOCAL_UNATTENDED_UNAVAILABLE" },
      );
    const args = {
      bearer,
      projectId: c.req.param("projectId"),
      harnessId: input.harnessId,
      workspaceGrantId: input.workspaceGrantId,
      waitForInstall: false,
    };
    try {
      const grant = await ensureLocalHarnessTarget({
        ...args,
        scope: "unattended",
        requireAutoApproveAcknowledgement: true,
      });
      const { actingUserId: _actor, ...target } = grant.target;
      c.header("Cache-Control", "no-store");
      return v1Resource(c, {
        target: localExecutionTargetSchema.parse({
          ...target,
          harnessId: input.harnessId,
          scope: "unattended",
        }),
        expiresAt: grant.expiresAt,
      });
    } catch (error) {
      if (error instanceof LocalHarnessRefusalError)
        return v1Error(c, error.code, error.message);
      if (error instanceof LocalAutoApproveConsentRequiredError) {
        return v1Error(
          c,
          "FORBIDDEN",
          `Allow ${name} to run commands without asking on this computer first: in Playground, turn Tool Approval off and confirm. Then retry.`,
          { reason: "LOCAL_AUTO_APPROVE_CONSENT_REQUIRED" },
        );
      }
      if (error instanceof LocalRuntimePreparingError) {
        return v1Error(c, "CONFLICT", error.message, {
          reason: "LOCAL_RUNTIME_PREPARING",
        });
      }
      throw error;
    }
  },
);
export default localExecution;
