import type { Context } from "hono";
import { z } from "zod";
import {
  createConvexClient,
  requireConvexHttpUrl,
  captureToolSnapshotForEvalAuthoring,
} from "../../services/evals/route-helpers.js";
import { createAuthorizedManager, callerContextFromHono } from "../web/auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { logger } from "../../utils/logger.js";
import {
  ErrorCode,
  WebRouteError,
  webErrorFromRoute,
  mapRuntimeError,
} from "../web/errors.js";
import { createEvalCasesInBatches } from "./eval-case-batch.js";
import {
  selectSuiteEnvironmentId,
  fetchSuiteRunServerSelection,
} from "../v1/evals.js";
import {
  resolveEnvironmentForLaunch,
  EVAL_LAUNCH_SERVER_SOURCE,
  translateEnvironmentResolveError,
  environmentServerIds,
  environmentServerNames,
} from "../../services/environments/resolve.js";

import { NO_READ_ONLY_TOOLS_MESSAGE } from "../../../shared/eval-generation-errors.js";
import { readOnlyGenerationSnapshot } from "../../services/eval-generation-coverage.js";

const startSchema = z
  .object({
    projectId: z.string().min(1),
    suiteId: z.string().min(1),
    requestKey: z.string().min(1).max(200),
    source: z.enum(["markdown", "generation", "agent"]),
    markdown: z.string().max(102400).optional(),
    fileName: z.string().max(255).optional(),
    instructions: z.string().max(100000).optional(),
    environmentId: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const operationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start"), input: startSchema }).strict(),
  z
    .object({ operation: z.literal("status"), jobId: z.string().min(1) })
    .strict(),
  z
    .object({ operation: z.literal("retry"), jobId: z.string().min(1) })
    .strict(),
  z
    .object({ operation: z.literal("cancel"), jobId: z.string().min(1) })
    .strict(),
  z
    .object({
      operation: z.literal("edit"),
      draftId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      case: z.unknown(),
      resolutions: z
        .record(z.string(), z.string().trim().min(10).max(2000))
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("accept"),
      draftId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      acceptedAdditionIds: z.array(z.string()).max(200),
    })
    .strict(),
  z
    .object({
      operation: z.literal("commit"),
      suiteId: z.string().min(1),
      draftId: z.string().min(1),
      revision: z.number().int().nonnegative(),
      caseId: z.string().min(1),
    })
    .strict(),
]);

export async function handleEvalAuthoring(c: Context, local: boolean) {
  try {
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > 750000)
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Authoring request is too large.",
      );
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid JSON body.",
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid authoring request.",
      );
    const token = local
      ? body.convexAuthToken
      : await getConvexBearerForRequest(c);
    if (local) delete body.convexAuthToken;
    if (typeof token !== "string" || !token)
      return c.json({ error: "Sign in to author cases." }, 401);
    const parsed = operationSchema.safeParse(body);
    if (!parsed.success)
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid authoring request.",
      );
    const request = parsed.data;
    const convex = createConvexClient(token);
    if (request.operation === "start") {
      const { input } = request;
      await convex.query("testSuites:checkCaseImportAccess" as any, {
        projectId: input.projectId,
        suiteId: input.suiteId,
      });
      const suite = await convex.query("testSuites:getTestSuite" as any, {
        suiteId: input.suiteId,
      });
      const environmentId = await selectSuiteEnvironmentId({
        convexAuthToken: token,
        projectId: input.projectId,
        suite,
        requestedEnvironmentId: input.environmentId,
        hasServerOverride: false,
        serverField: "servers",
      });
      const environment = environmentId
        ? await resolveEnvironmentForLaunch(convex, {
            serverSource: EVAL_LAUNCH_SERVER_SOURCE,
            projectId: input.projectId,
            environmentId,
          }).catch((error) => {
            throw translateEnvironmentResolveError(error);
          })
        : undefined;
      const selection = environment
        ? {
            serverIds: environmentServerIds(environment),
            serverNames: environmentServerNames(environment),
          }
        : await fetchSuiteRunServerSelection(token, input.suiteId, undefined);
      const { manager } = await createAuthorizedManager(
        callerContextFromHono(c),
        token,
        input.projectId,
        selection.serverIds,
        30_000,
        undefined,
        undefined,
        { serverNames: selection.serverNames },
      );
      let toolSnapshot;
      try {
        ({ toolSnapshot } = await captureToolSnapshotForEvalAuthoring(
          manager,
          selection.serverIds,
        ));
      } finally {
        await manager.disconnectAllServers();
      }
      if (input.options?.toolCoverage === "read-only" && toolSnapshot) {
        try {
          toolSnapshot = readOnlyGenerationSnapshot(toolSnapshot);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === NO_READ_ONLY_TOOLS_MESSAGE
          )
            throw new WebRouteError(
              400,
              ErrorCode.VALIDATION_ERROR,
              error.message,
            );
          throw error;
        }
      }
      const { environmentId: _environmentId, ...source } = input;
      const response = await fetch(
        `${requireConvexHttpUrl()}/eval-authoring/v1/jobs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "x-inspector-service-token":
              process.env.INSPECTOR_SERVICE_TOKEN ?? "",
          },
          body: JSON.stringify({
            ...source,
            version: 1,
            ...(c.get("workosApiKeyId")
              ? { apiKeyId: c.get("workosApiKeyId") }
              : {}),
            toolSnapshot,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        logger.warn("Authoring service returned a non-JSON response", {
          status: response.status,
          contentType: response.headers.get("content-type"),
        });
        return c.json(
          {
            code: "authoring_upstream_invalid_response",
            upstreamStatus: response.status,
            error:
              "The case authoring service is unavailable. Please try again.",
          },
          502,
        );
      }
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (request.operation === "status")
      return c.json(
        await convex.query("evalAuthoringState:status" as any, {
          jobId: request.jobId,
        }),
      );
    if (request.operation === "retry") {
      await convex.mutation("evalAuthoringState:retry" as any, {
        jobId: request.jobId,
      });
      return c.json({ ok: true });
    }
    if (request.operation === "cancel") {
      await convex.mutation("evalAuthoringState:cancel" as any, {
        jobId: request.jobId,
      });
      return c.json({ ok: true });
    }
    if (request.operation === "edit")
      return c.json(
        await convex.mutation("evalAuthoringState:editDraft" as any, {
          draftId: request.draftId,
          revision: request.revision,
          case: request.case,
          ...(request.resolutions ? { resolutions: request.resolutions } : {}),
        }),
      );
    if (request.operation === "accept") {
      await convex.mutation("evalAuthoringState:acceptDraft" as any, {
        draftId: request.draftId,
        revision: request.revision,
        acceptedAdditionIds: request.acceptedAdditionIds,
      });
      return c.json({ ok: true });
    }
    const item = await convex.mutation(
      "evalAuthoringState:prepareCommit" as any,
      {
        draftId: request.draftId,
        revision: request.revision,
        caseId: request.caseId,
      },
    );
    return c.json(
      await createEvalCasesInBatches(convex, {
        suiteId: request.suiteId,
        duplicatePolicy: "block",
        cases: [item],
      }),
    );
  } catch (error) {
    return webErrorFromRoute(c, mapRuntimeError(error));
  }
}
