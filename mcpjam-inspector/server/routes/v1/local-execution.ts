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
  LocalHarnessRefusalError,
  ensureLocalHarnessTarget,
  LocalRuntimePreparingError,
} from "../../utils/harness/local/readiness.js";
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
      if (error instanceof LocalHarnessRefusalError) return v1Error(c, error.code, error.message);
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
