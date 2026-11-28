/**
 * Production traffic reads for a project's members (PT-1):
 *
 *   GET /v1/projects/:projectId/production/counts
 *   GET /v1/projects/:projectId/production/calls
 *
 * Metadata only; no argument or result content is served here. Membership is
 * checked with the caller's own bearer through Convex
 * (`projects:getProjectCapabilities`) before the store is read, so this route
 * forwards the bearer and Convex verifies it. A producer credential is not a
 * user, and Convex refuses it there.
 *
 * Query: `from` and `to` (epoch ms; default the last 24 hours, at most 30
 * days), optional `serviceName`; for calls, optional `reason` and `limit`
 * (default 50, at most 200).
 */
import { Hono, type Context } from "hono";
import { createConvexClient } from "./convex-client.js";
import { requireProjectIdArg } from "./convex-id-param.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { v1Error, v1Resource } from "./envelope.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { getProductionTrafficStore } from "../../services/production-traffic/clickhouse-store.js";
import {
  TRAFFIC_RULES_VERSION,
  TrafficStoreUnavailableError,
  type ProductionTrafficStore,
  type ReviewReason,
  type TrafficWindow,
} from "../../services/production-traffic/store.js";

const SCOPE = "v1.production-traffic";
const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 30 * DAY_MS;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const REASONS: ReadonlySet<string> = new Set<ReviewReason>([
  "protocol_error",
  "rejected_request",
  "tool_error",
  "outcome_not_met",
  "random_sample",
]);

function invalid(message: string): never {
  throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message);
}

async function requireProjectMember(c: Context): Promise<string> {
  const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let row: unknown;
  try {
    row = await client.query(
      "projects:getProjectCapabilities" as never,
      { projectId } as never,
    );
  } catch (error) {
    throw translateConvexReadError(error, {
      scope: SCOPE,
      notFoundMessage: "Project not found",
      redactedIsRefusal: true,
    });
  }
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Project not found");
  }
  return projectId;
}

function readWindow(c: Context): TrafficWindow {
  const now = Date.now();
  const toMs =
    c.req.query("to") === undefined ? now : Number(c.req.query("to"));
  const fromMs =
    c.req.query("from") === undefined
      ? toMs - DAY_MS
      : Number(c.req.query("from"));
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)) {
    invalid("`from` and `to` must be epoch milliseconds.");
  }
  if (fromMs >= toMs || toMs - fromMs > MAX_WINDOW_MS) {
    invalid("`from` must be before `to`, at most 30 days apart.");
  }
  const serviceName = c.req.query("serviceName");
  if (serviceName !== undefined && (!serviceName || serviceName.length > 256)) {
    invalid("`serviceName` must be 1 to 256 characters.");
  }
  return { fromMs, toMs, ...(serviceName ? { serviceName } : {}) };
}

/** Runs one store read, answering the outages a caller can retry. */
async function withStore(
  c: Context,
  read: (store: ProductionTrafficStore) => Promise<Response>,
): Promise<Response> {
  const store = getProductionTrafficStore();
  if (!store) {
    return v1Error(
      c,
      "FEATURE_NOT_SUPPORTED",
      "Production traffic is not set up on this MCPJam deployment.",
    );
  }
  try {
    return await read(store);
  } catch (error) {
    if (error instanceof TrafficStoreUnavailableError) {
      return v1Error(
        c,
        "SERVER_UNREACHABLE",
        "Production traffic storage is unavailable. Try again in a minute.",
      );
    }
    throw error;
  }
}

const reads = new Hono();

reads.get("/projects/:projectId/production/counts", async (c) => {
  const projectId = await requireProjectMember(c);
  const window = readWindow(c);
  return withStore(c, async (store) =>
    v1Resource(c, {
      projectId,
      window,
      ...(await store.counts(projectId, window)),
    }),
  );
});

reads.get("/projects/:projectId/production/calls", async (c) => {
  const projectId = await requireProjectMember(c);
  const window = readWindow(c);
  const reason = c.req.query("reason");
  if (reason !== undefined && !REASONS.has(reason)) {
    invalid(`\`reason\` must be one of: ${[...REASONS].join(", ")}.`);
  }
  const limit =
    c.req.query("limit") === undefined
      ? DEFAULT_LIMIT
      : Number(c.req.query("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    invalid(`\`limit\` must be 1 to ${MAX_LIMIT}.`);
  }
  return withStore(c, async (store) => {
    const items = await store.listCalls(projectId, {
      ...window,
      ...(reason ? { reason: reason as ReviewReason } : {}),
      limit,
    });
    return v1Resource(c, {
      projectId,
      rulesVersion: TRAFFIC_RULES_VERSION,
      window,
      items,
    });
  });
});

export default reads;
