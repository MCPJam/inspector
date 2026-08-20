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
import { getInternalBackendConfig } from "../../services/internal-backend.js";
import { createStreamingPinnedFetch } from "../../utils/pinned-fetch.js";
import { logger } from "../../utils/logger.js";
import { executeHostedReadinessRun } from "../../services/readiness/worker.js";
import { translateConvexWriteError as translateConvexError } from "./convex-errors.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import type { OpenAISubmissionMode } from "@mcpjam/sdk";

const readiness = new Hono();

/** The two words the public vocabulary uses. Never `anthropic`/`chatgpt`. */
const PUBLISHERS = ["claude", "openai"] as const;
type Publisher = (typeof PUBLISHERS)[number];

/**
 * The submission shapes a HOSTED run may grade.
 *
 * The package shapes need an upload this API has no way to receive, and the
 * refusal names the CLI rather than pretending the shape does not exist. The
 * backend refuses them too; this is the layer that can explain why.
 */
const HOSTED_SUBMISSION_MODES = ["mcp-only", "mcp-imported-skills"] as const;

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

/** The run row as the public API renders it. */
function toRunDto(run: Record<string, any>) {
  return {
    id: run.id,
    readinessKind: run.readinessKind,
    serverUrl: run.serverUrl,
    submissionMode: run.submissionMode ?? null,
    status: run.status,
    overallStatus: run.overallStatus ?? null,
    lanes: run.lanes ?? [],
    stages: run.stages ?? [],
    authMode: run.authMode ?? null,
    capabilities: run.capabilities ?? [],
    attemptCount: run.attemptCount,
    terminalReason: run.terminalReason ?? null,
    errorMessage: run.errorMessage ?? null,
    policySnapshotDate: run.policySnapshotDate ?? null,
    engineVersion: run.engineVersion ?? null,
    sdkVersion: run.sdkVersion ?? null,
    // The AI axis, ALWAYS present and independent of `status`. A run whose
    // lanes graded cleanly is `completed` even when the observation call was
    // refused for credit, and a reader has to be able to see both.
    includeLlmObservations: run.includeLlmObservations ?? false,
    llmObservations: run.llmObservations ?? {
      status: "not-requested",
      reason: "not_requested",
    },
    hasReport: run.hasReport === true,
    reportUrl: run.hasReport
      ? `/api/v1/projects/${run.projectId ?? ""}/readiness-runs/${run.id}/report`
      : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
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
  const config = authorized.serverConfig;
  if (config.transportType !== "http" || !config.url) {
    // Readiness grades what a HOST would see, and every host in question
    // reaches a server over HTTP. A stdio server is not a connector these
    // directories can list, so this is a wrong-shape refusal rather than a gap.
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Directory readiness grades HTTP connectors; this server uses a different transport.",
    );
  }

  const convex = createConvexClient(convexAuthToken);
  let created: { runId: string; jobId: string; reused: boolean };
  try {
    created = await convex.mutation(
      "claudeReadinessRuns:requestReadinessRun" as any,
      {
        projectId,
        serverId,
        serverUrl: config.url,
        readinessKind: publisher,
        ...(submissionMode ? { submissionMode } : {}),
        ...(body.idempotencyKey
          ? { idempotencyKey: body.idempotencyKey }
          : {}),
        includeLlmObservations: body.includeLlmObservations === true,
        authMode: config.useOAuth ? "provided-token" : "headless",
      },
    );
  } catch (error) {
    throw translateConvexError(error, { resource: "Readiness run" });
  }

  // A REPLAY EXECUTES NOTHING. The run it names is already in flight or
  // already finished; starting a second execution against the same lease would
  // dial a third party's server twice for one logical request, which is the
  // exact thing the idempotency key was sent to prevent.
  if (!created.reused) {
    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    if (authorized.oauthAccessToken) {
      headers.authorization = `Bearer ${authorized.oauthAccessToken}`;
    }

    void executeHostedReadinessRun({
      lease: { runId: created.runId, jobId: created.jobId },
      publisher,
      target: config.url,
      submissionMode,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      // The DNS-pinned transport: resolve once, refuse the disallowed answers,
      // pin the surviving addresses into the socket, re-run it on every hop.
      fetchFn: createStreamingPinnedFetch({
        targetLabel: "MCP server",
        chainTimeoutMs: 30_000,
        bodyIdleTimeoutMs: 120_000,
        maxResponseBytes: 32 * 1024 * 1024,
      }),
      includeLlmObservations: body.includeLlmObservations === true,
    }).catch((error) => {
      // `executeHostedReadinessRun` never throws — every exit lands the run
      // somewhere terminal. This catch exists for the impossible case, so an
      // unhandled rejection cannot take the process with it.
      logger.error("[v1 readiness] detached run escaped its own handler", error, {
        runId: created.runId,
      });
    });
  }

  return v1Resource(
    c,
    {
      runId: created.runId,
      projectId,
      serverId,
      readinessKind: publisher,
      status: created.reused ? "pending" : "pending",
      deduped: created.reused,
      includeLlmObservations: body.includeLlmObservations === true,
    },
    202,
  );
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
  return v1Resource(c, toRunDto({ ...run, projectId }));
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
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "limit must be a positive integer",
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
    runs.map((run) => toRunDto({ ...run, projectId })),
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
    const response = await fetch(
      `${convexUrl}/internal/v1/claude-readiness/runs/report?runId=${encodeURIComponent(runId)}`,
      { headers: { "x-inspector-service-token": serviceToken } },
    );
    if (response.status === 404) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "This readiness run's report is no longer stored.",
      );
    }
    if (!response.ok) {
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "The readiness report could not be read from storage.",
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
