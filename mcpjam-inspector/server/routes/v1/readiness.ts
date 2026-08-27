/**
 * Public `/api/v1` directory readiness.
 *
 * ## The shape, and why it is asynchronous
 *
 * A readiness run dials somebody else's server, walks its redirect chain,
 * discovers its authorization metadata, lists its tools and — when the caller
 * asked and paid — has a model read the result. That is not a request anyone
 * should hold a connection open for, so a start is a `202` plus a run id and
 * everything after it is a separate operation: read it, list them, cancel one,
 * fetch its report.
 *
 * ## What the caller may say, and what it may not
 *
 * PATH AND AUTH DECIDE TARGET AND PAYER. The URL names a project and a saved
 * server; the bearer names an actor; the backend derives the billing
 * organization from the project. A body may not supply a URL, an actor, an
 * organization, a provider key, a model or a cost — not "is ignored if it
 * does", but is REFUSED, because a caller that believed it had chosen a payer
 * should find out rather than be silently overruled.
 *
 * Bodies are `strictObject` for the same reason the server routes are: an
 * unknown key is a 400 rather than a silent forward. A start endpoint that
 * accepted an unknown key would let a typo'd `includeLLMObservations` read as
 * "AI off" while the caller believed it was on — or, once the spelling was
 * fixed, the reverse.
 *
 * ## Where the run actually executes
 *
 * In THIS process, detached, holding the lease `requestReadinessRun` handed
 * back. The eval routes do the same thing for the same reason. The backend's
 * recovery cron is what makes that safe: a node that dies stops heartbeating
 * and the run is re-queued with a fresh job id, so this node coming back
 * cannot write into the attempt that replaced it.
 */

import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { authorizeServer, parseWithSchema } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { captureServerEvent } from "../../utils/analytics.js";
import type { ServerAnalyticsActor } from "../../utils/analytics.js";
import type { RequestLogContext } from "../../utils/log-events.js";
import { getInternalBackendConfig } from "../../services/internal-backend.js";
import { translateConvexWriteError as translateConvexError } from "./convex-errors.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import {
  HOSTED_SUBMISSION_MODES,
  READINESS_PUBLISHERS as PUBLISHERS,
  startHostedReadinessRun,
  toReadinessRunDto,
  type ReadinessPublisher as Publisher,
} from "../shared/readiness-runs.js";
import type { OpenAISubmissionMode } from "@mcpjam/sdk";

const readiness = new Hono();

/** The largest page this endpoint will ask the backend for. */
const READINESS_LIST_MAX_LIMIT = 100;

/**
 * How long the service-token read of a report blob may take.
 *
 * Without it the fetch inherits no deadline at all: a backend that accepts the
 * socket and then stalls holds this request open for as long as it pleases,
 * and the caller cannot tell that from a very large report.
 */
const REPORT_FETCH_TIMEOUT_MS = 30_000;

function createConvexClient(convexAuthToken: string): ConvexHttpClient {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration",
    );
  }
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(convexAuthToken);
  return client;
}

/**
 * The fields a start body may carry.
 *
 * `includeLlmObservations` DEFAULTS TO FALSE and is the only field that can
 * spend. Defaulting it on would make every existing caller start paying on the
 * day this shipped, which is the one behaviour a billed opt-in may not have.
 */
const startFields = {
  /**
   * Deduplicates a retried POST.
   *
   * More load-bearing here than usual: a readiness run dials somebody else's
   * server, and a retried start that created a second run would do that twice.
   */
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  /** Opt in to model-backed observations, which SPEND MCPJam credits. */
  includeLlmObservations: z.boolean().optional(),
};

const startClaudeSchema = z.strictObject(startFields);

const startOpenAISchema = z.strictObject({
  ...startFields,
  /**
   * The DECLARED submission shape. REQUIRED, and never inferred.
   *
   * Inference reads a forgotten package as "MCP-only", which reports the
   * package lane `not-applicable` — turning a missing input into a clean bill
   * of health, which is the exact failure `incomplete` exists to prevent.
   */
  submissionMode: z.enum(HOSTED_SUBMISSION_MODES),
});

/**
 * The run row as the public API renders it.
 *
 * The projection itself is shared with the web surface; what `/api/v1` adds is
 * a report LINK, because a public caller has no other way to discover the
 * endpoint that serves the bytes.
 */
function toRunDto(run: Record<string, any>, projectId: string) {
  return toReadinessRunDto(run, {
    projectId,
    reportUrl: (runId) =>
      `/api/v1/projects/${projectId}/readiness-runs/${runId}/report`,
  });
}

/**
 * The identity a detached run's terminal event is attributed to.
 *
 * Resolved HERE, while the request still exists, because by the time the run
 * finishes there is no `Context` left to read it from — and the terminal event
 * is the one that carries the verdict. Returns `undefined` rather than
 * inventing an identity when none resolves: an event attributed to nobody is
 * worse than no event, since an unmatched `distinct_id` pollutes person
 * profiles.
 */
function readinessAnalyticsActor(
  c: any,
  projectId: string,
): ServerAnalyticsActor | undefined {
  const ctx = c.var?.requestLogContext as RequestLogContext | undefined;
  const distinctId =
    ctx?.userExternalId ?? ctx?.guestExternalId ?? c.get?.("guestId") ?? null;
  if (!distinctId) return undefined;
  return {
    distinctId,
    organizationId: ctx?.orgId ?? undefined,
    projectId: ctx?.projectId ?? projectId,
  };
}

/**
 * Start one run: authorize the server, create the leased row, detach.
 *
 * The TARGET comes from the saved server the path names, resolved through the
 * same authorize exchange every other server route uses — never from the body.
 * That is what makes "a caller cannot point this at an arbitrary URL" true by
 * construction rather than by validation.
 */
async function startRun(
  c: any,
  publisher: Publisher,
  submissionMode: OpenAISubmissionMode | undefined,
  body: { idempotencyKey?: string; includeLlmObservations?: boolean },
) {
  const projectId = c.req.param("projectId");
  const serverId = c.req.param("serverId");
  const convexAuthToken = await getConvexBearerForRequest(c);

  const authorized = await authorizeServer(
    c,
    convexAuthToken,
    projectId,
    serverId,
  );

  const receipt = await startHostedReadinessRun({
    convex: createConvexClient(convexAuthToken),
    projectId,
    serverId,
    publisher,
    submissionMode,
    idempotencyKey: body.idempotencyKey,
    includeLlmObservations: body.includeLlmObservations === true,
    authorized,
    analyticsActor: readinessAnalyticsActor(c, projectId),
    translateError: (error) =>
      translateConvexError(error, { resource: "Readiness run" }),
  });

  // Fired for replays too — see the event's note. The server URL is not a
  // property here and must not become one.
  captureServerEvent(c, "directory_readiness_run_started_server", {
    readiness_kind: publisher,
    submission_mode: submissionMode ?? null,
    include_llm_observations: body.includeLlmObservations === true,
    deduped: receipt.deduped,
    run_status: receipt.status,
  });

  return v1Resource(c, receipt, 202);
}

// ── Start ───────────────────────────────────────────────────────────────

readiness.post(
  "/projects/:projectId/servers/:serverId/readiness-runs/claude",
  async (c) => {
    const body = parseWithSchema(startClaudeSchema, await readBody(c));
    return startRun(c, "claude", undefined, body);
  },
);

readiness.post(
  "/projects/:projectId/servers/:serverId/readiness-runs/openai",
  async (c) => {
    const body = parseWithSchema(startOpenAISchema, await readBody(c));
    return startRun(c, "openai", body.submissionMode, body);
  },
);

/**
 * Read the body, treating an ACTUALLY empty one as `{}`.
 *
 * Whitespace is malformed JSON and a literal `null` is a value the schema
 * should reject; treating either as "no body" would let a request nobody wrote
 * start a run against somebody else's server.
 */
async function readBody(c: any): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be valid JSON.",
    );
  }
}

// ── Read ────────────────────────────────────────────────────────────────

readiness.get("/projects/:projectId/readiness-runs/:runId", async (c) => {
  const projectId = c.req.param("projectId");
  const runId = c.req.param("runId");
  const convex = createConvexClient(await getConvexBearerForRequest(c));

  let run: Record<string, any> | null;
  try {
    run = await convex.query("claudeReadinessRuns:getReadinessRun" as any, {
      runId,
    });
  } catch (error) {
    throw translateConvexError(error, { resource: "Readiness run" });
  }
  if (!run) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Readiness run not found");
  }
  return v1Resource(c, toRunDto(run, projectId));
});

readiness.get("/projects/:projectId/readiness-runs", async (c) => {
  const projectId = c.req.param("projectId");
  const convex = createConvexClient(await getConvexBearerForRequest(c));

  const publisher = c.req.query("readinessKind");
  if (publisher !== undefined && !PUBLISHERS.includes(publisher as Publisher)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "readinessKind must be claude or openai",
    );
  }
  const serverId = c.req.query("serverId");
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  // An INTEGER and a CEILING, not merely a finite number. `Number.isFinite`
  // admits `2.5` and `1e9` alike and forwards both to the backend, so a page
  // cap with no upper bound is an invitation to ask for every run an
  // organization has ever recorded in one request.
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > READINESS_LIST_MAX_LIMIT)
  ) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      `limit must be an integer between 1 and ${READINESS_LIST_MAX_LIMIT}`,
    );
  }

  let runs: Record<string, any>[];
  try {
    runs = await convex.query("claudeReadinessRuns:listReadinessRuns" as any, {
      projectId,
      ...(serverId ? { serverId } : {}),
      ...(publisher ? { readinessKind: publisher } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (error) {
    throw translateConvexError(error, { resource: "Readiness runs" });
  }
  return v1PageJson(
    c,
    runs.map((run) => toRunDto(run, projectId)),
  );
});

// ── Cancel ──────────────────────────────────────────────────────────────

readiness.post(
  "/projects/:projectId/readiness-runs/:runId/cancel",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const convex = createConvexClient(await getConvexBearerForRequest(c));

    try {
      await convex.mutation(
        "claudeReadinessRuns:cancelReadinessRun" as any,
        { runId },
      );
    } catch (error) {
      throw translateConvexError(error, { resource: "Readiness run" });
    }
    // The executing node learns about this on its next heartbeat, which
    // answers `alive: false` and aborts the run in flight. That matters more
    // than the row's status: the thing being stopped is traffic to somebody
    // else's server.
    return v1Resource(c, { runId, projectId, status: "cancelled" });
  },
);

// ── Report ──────────────────────────────────────────────────────────────

readiness.get(
  "/projects/:projectId/readiness-runs/:runId/report",
  async (c) => {
    const runId = c.req.param("runId");
    const convex = createConvexClient(await getConvexBearerForRequest(c));

    let blobId: string | null;
    try {
      blobId = await convex.query(
        "claudeReadinessRuns:getReadinessReportBlobId" as any,
        { runId },
      );
    } catch (error) {
      throw translateConvexError(error, { resource: "Readiness report" });
    }
    if (!blobId) {
      // A run with no report is not a missing run: it may be in flight, it may
      // have failed, or its report may have aged past retention. Saying which
      // is the run detail's job; this only says there is nothing to fetch.
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "This readiness run has no stored report.",
      );
    }

    // THE SECOND GATE. The query above ran `requireProjectRole` under the
    // CALLER's identity, so reaching this line already proves access. The blob
    // itself can only be read from inside Convex, so the bytes come back over
    // the service-token route — which takes a RUN id rather than a blob id,
    // precisely so a node cannot use it to read blobs belonging to other
    // features.
    const { convexUrl, serviceToken } = getInternalBackendConfig();
    let response: Response;
    try {
      response = await fetch(
        `${convexUrl}/internal/v1/claude-readiness/runs/report?runId=${encodeURIComponent(runId)}`,
        {
          headers: { "x-inspector-service-token": serviceToken },
          signal: AbortSignal.timeout(REPORT_FETCH_TIMEOUT_MS),
        },
      );
    } catch {
      // A DNS failure, a refused connection or the deadline above. Uncaught,
      // each of these surfaces as an opaque 500 — the same shape the two
      // branches below take care to report as a 502, because none of them is
      // the caller's fault.
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "The readiness report could not be read from storage.",
      );
    }
    if (!response.ok) {
      // Neither branch reads the body, and an unread body holds its keep-alive
      // connection until GC. Cancelling hands it back now.
      await response.body?.cancel().catch(() => undefined);
      throw new WebRouteError(
        response.status === 404 ? 404 : 502,
        response.status === 404
          ? ErrorCode.NOT_FOUND
          : ErrorCode.INTERNAL_ERROR,
        response.status === 404
          ? "This readiness run's report is no longer stored."
          : "The readiness report could not be read from storage.",
      );
    }
    // Streamed through rather than buffered: a readiness report carries
    // per-finding evidence and can reach megabytes, and holding one in memory
    // per concurrent reader is a cost with no upside.
    return new Response(response.body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
);

export default readiness;
