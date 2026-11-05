import type { Context } from "hono";
import { z } from "zod";
import { getConvexBearerForRequest } from "./v1-convex-token.js";
import { serviceCredentialHeaders } from "../services/service-credential.js";
import { WebRouteError, ErrorCode } from "../routes/web/errors.js";

const sourceRequest = z.object({
  projectId: z.string().min(1),
  serverId: z.string().min(1),
  connectionId: z.string().optional(),
  wire: z.enum(["legacy", "extension"]),
  sourceExecutions: z.record(
    z.string().min(1).max(512),
    z.string().min(1).max(512),
  ),
  taskId: z.string().optional(),
  taskIds: z.array(z.string()).max(50).optional(),
});

/** Authority is mandatory for every supplied source, independent of recovery availability. */
export async function authorizeTaskSources(
  c: Context,
  raw: Record<string, unknown>,
) {
  if (raw.sourceExecutions === undefined) return;
  const parsed = sourceRequest.safeParse(raw);
  if (!parsed.success)
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid Task execution sources.",
    );
  const request = parsed.data;
  const ids = request.taskIds ?? (request.taskId ? [request.taskId] : []);
  const sources = Object.entries(request.sourceExecutions).map(
    ([taskId, sourceExecutionId]) => ({ taskId, sourceExecutionId }),
  );
  if (
    !sources.length ||
    sources.length > 50 ||
    sources.some(({ taskId }) => !ids.includes(taskId))
  )
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Invalid Task execution sources.",
    );
  const base = process.env.CONVEX_HTTP_URL;
  if (!base)
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Task authorization is unavailable. Try again.",
    );
  const bearer = await getConvexBearerForRequest(c);
  const response = await fetch(
    `${base}/internal/v1/hosted-task-sources/authorize`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        ...serviceCredentialHeaders(),
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        projectId: request.projectId,
        serverId: request.serverId,
        connectionId: request.connectionId,
        wire: request.wire,
        sources,
      }),
    },
  );
  if (!response.ok)
    throw new WebRouteError(
      response.status === 403 ? 403 : 503,
      response.status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.INTERNAL_ERROR,
      "This Task cannot be accessed from the current chat or account.",
    );
  const parsedResult = z
    .object({
      allowed: z.literal(true),
      binding: z.string(),
      hostConfig: z.record(z.string(), z.unknown()),
    })
    .safeParse(await response.json());
  if (!parsedResult.success)
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Task authorization is unavailable. Try again.",
    );
  return parsedResult.data;
}
