import type { Context } from "hono";
import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "../evals/route-helpers.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/** Resolve legacy display names only inside this request's authorized project. */
export async function normalizeLocalManagedRequest(
  c: Context,
  body: Record<string, unknown>,
) {
  if (body.selectedServerIds !== undefined) {
    if (
      !Array.isArray(body.selectedServerIds) ||
      body.selectedServerIds.some((id) => typeof id !== "string" || !id)
    ) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "selectedServerIds must contain saved server IDs",
      );
    }
    return body;
  }
  if (body.selectedServers === undefined) return body;
  const names = body.selectedServers;
  if (
    !Array.isArray(names) ||
    names.some((name) => typeof name !== "string" || !name)
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "selectedServers must contain server names",
    );
  }
  if (!names.length) return { ...body, selectedServerIds: [] };
  if (typeof body.projectId !== "string" || !body.projectId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "A project is required to resolve saved servers",
    );
  }
  const client = createConvexClient(await getConvexBearerForRequest(c));
  const servers = await client.query(
    makeFunctionReference<
      "query",
      { projectId: string },
      Array<{ _id: string; name: string }>
    >("servers:getProjectServers"),
    { projectId: body.projectId },
  );
  const selectedServerIds = names.map((name) => {
    const matches = servers.filter((server) => server.name === name);
    if (matches.length !== 1) {
      throw new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        "A selected server is missing or ambiguous. Save the server in this project and retry.",
      );
    }
    return matches[0]._id;
  });
  return { ...body, selectedServerIds, selectedServerNames: names };
}

/** A restored managed conversation cannot switch authority by omitting its project. */
export async function assertStandaloneConversation(
  c: Context,
  sessionId: string,
) {
  const origin = process.env.CONVEX_HTTP_URL;
  if (!origin)
    throw new Error("Managed conversation lookup requires a backend");
  const url = new URL("direct-chat/detail", `${origin.replace(/\/$/, "")}/`);
  url.searchParams.set("chatSessionId", sessionId);
  const bearer = await getConvexBearerForRequest(c);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${bearer.replace(/^Bearer /, "")}` },
    signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10000)]),
  });
  if (response.status === 404) return;
  if (!response.ok)
    throw new WebRouteError(
      response.status,
      ErrorCode.FORBIDDEN,
      "Could not verify this conversation's original setup. Retry before continuing.",
    );
  const detail = (await response.json()) as {
    ok?: boolean;
    session?: {
      projectId?: string;
      resumeConfig?: { environmentId?: string; executionTarget?: unknown };
    };
  };
  if (detail.ok !== true) throw new Error("Invalid conversation lookup response");
  if (
    detail.session?.projectId ||
    detail.session?.resumeConfig?.environmentId ||
    detail.session?.resumeConfig?.executionTarget
  ) {
    throw new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "Restore this conversation's project and saved setup before continuing.",
    );
  }
}
