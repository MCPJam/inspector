import { Hono } from "hono";
import { z } from "zod";
import {
  MCP_PROTOCOL_VERSIONS,
  oauthConformanceProfileSchema,
  type MCPServerConfig,
} from "@mcpjam/sdk";
import { handleRoute, projectServerSchema } from "./auth.js";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  webErrorFromRoute,
} from "./errors.js";
import { getInternalBackendConfig } from "../../services/internal-backend.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  OAuthConformanceSessionFailedError,
  OAuthConformanceSessionNotFoundError,
  UnsupportedTransportError,
  completeOAuthConformance,
  runAppsConformance,
  runProtocolConformance,
  runTasksConformance,
  startOAuthConformance,
  submitOAuthConformanceCode,
} from "../shared/conformance";
import { authorizeServer, toHttpConfig } from "./auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
  assertAllowedHostedTargetUrl,
} from "../../utils/hosted-egress-guard.js";
import { ConvexHttpClient } from "convex/browser";
import {
  HOSTED_SUBMISSION_MODES,
  startHostedReadinessRun,
  toReadinessRunDto,
  type ReadinessPublisher,
} from "../shared/readiness-runs.js";

const conformanceWeb = new Hono();

/**
 * A Convex client speaking as the CALLER, not as this node.
 *
 * The readiness mutations and queries all run `requireProjectRole` internally,
 * which only means anything if the identity reaching Convex is the user's. A
 * service-token client here would authorize every request as the inspector
 * itself and hand any signed-in user any organization's runs.
 */
function createReadinessConvexClient(bearerToken: string): ConvexHttpClient {
  try {
    // The SHARED factory, not a second copy of the same three lines. It is the
    // one place that decides which environment variable names the Convex
    // CLIENT url — `.convex.cloud`, which is not the `.convex.site` HTTP-actions
    // url the service-token fetch below uses, and confusing the two is a
    // mistake worth having exactly one place to make.
    return createConvexClient(bearerToken);
  } catch (error) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      error instanceof Error ? error.message : "Convex is not configured"
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Every URL these routes will dial passes through here.
 *
 * Hosted, a conformance run is an anonymous caller naming a target and our
 * cloud backend connecting to it — an SSRF primitive unless the target is
 * checked. Two inputs reach the dialer: the URL Convex resolved for the
 * authorized server row, and `oauthProfile.serverUrl`, which the OAuth suite
 * lets a caller supply directly. Neither was validated before.
 *
 * Local/desktop mode is exempt by construction (the guard no-ops outside
 * `HOSTED_MODE`): testing a server on localhost is the inspector's whole job.
 *
 * Only the TARGET is judged, never the Host headers the protocol suite sends
 * — its `localhost-host-rebinding-rejected` checks deliberately send
 * rebinding-shaped Host values to grade the server's own defenses.
 */
async function assertConformanceTarget(
  rawUrl: string,
  label: string
): Promise<void> {
  try {
    await assertAllowedHostedTargetUrl(rawUrl, label);
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    // We could not reach a verdict. That is our outage, not a bad request —
    // answer 503 so the caller knows it is worth trying again.
    if (error instanceof EgressResolutionError) {
      throw new WebRouteError(503, ErrorCode.SERVER_UNREACHABLE, error.message);
    }
    throw error;
  }
}

/** Resolve HTTP server URL and headers for conformance from authorized config. */
async function resolveHostedHttpConfig(
  c: any,
  bearerToken: string,
  body: Record<string, unknown>
): Promise<{
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
}> {
  const wsBody = parseWithSchema(projectServerSchema, body);
  const auth = await authorizeServer(
    c,
    bearerToken,
    wsBody.projectId,
    wsBody.serverId,
    {
      accessScope: wsBody.accessScope,
      scenarioId: wsBody.scenarioId,
      accessVersion: wsBody.accessVersion,
    }
  );

  if (auth.serverConfig.transportType !== "http") {
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "Protocol conformance requires HTTP transport"
    );
  }

  if (!auth.serverConfig.url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Authorized server is missing URL"
    );
  }

  const oauthToken =
    typeof wsBody.oauthAccessToken === "string"
      ? wsBody.oauthAccessToken
      : undefined;
  const headers: Record<string, string> = {
    ...(auth.serverConfig.headers ?? {}),
  };
  if (oauthToken) {
    headers["Authorization"] = `Bearer ${oauthToken}`;
  }

  await assertConformanceTarget(auth.serverConfig.url, "Server URL");

  return {
    serverUrl: auth.serverConfig.url,
    accessToken: undefined, // OAuth token goes in headers
    customHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

/** Resolve any-transport server config for Apps/Tasks conformance on hosted. */
async function resolveHostedServerConfig(
  c: any,
  bearerToken: string,
  body: Record<string, unknown>
): Promise<MCPServerConfig> {
  const wsBody = parseWithSchema(projectServerSchema, body);
  const auth = await authorizeServer(
    c,
    bearerToken,
    wsBody.projectId,
    wsBody.serverId,
    {
      accessScope: wsBody.accessScope,
      scenarioId: wsBody.scenarioId,
      accessVersion: wsBody.accessVersion,
    }
  );

  const httpConfig = toHttpConfig(
    auth,
    WEB_CALL_TIMEOUT_MS,
    typeof wsBody.oauthAccessToken === "string"
      ? wsBody.oauthAccessToken
      : undefined,
    wsBody.clientCapabilities as Record<string, unknown> | undefined
  );

  // Apps/Tasks accept any transport, so there may be no URL to judge (a stdio
  // config never leaves the box). Guard the ones that do.
  const url = (httpConfig as { url?: unknown }).url;
  if (typeof url === "string" && url) {
    await assertConformanceTarget(url, "Server URL");
  }

  return httpConfig as MCPServerConfig;
}

/**
 * Bound a whole conformance run by wall-clock, not just its individual legs.
 * Losing the race rejects with a 504 so the route always answers inside the
 * hosted budget; the run itself keeps unwinding in the background (its legs
 * are individually timed out) and closes its own client.
 */
async function withHostedDeadline<T>(
  run: Promise<T>,
  deadlineMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WebRouteError(504, ErrorCode.TIMEOUT, message)),
      deadlineMs
    );
  });
  // Never leave the losing run as an unhandled rejection.
  run.catch(() => {});
  try {
    return await Promise.race([run, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toWebError(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  if (error instanceof UnsupportedTransportError) {
    return new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      error.message
    );
  }
  if (error instanceof OAuthConformanceSessionNotFoundError) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, error.message);
  }
  if (error instanceof OAuthConformanceSessionFailedError) {
    return new WebRouteError(500, ErrorCode.INTERNAL_ERROR, error.message);
  }
  return new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : "Unknown error"
  );
}

// ── POST /protocol ──────────────────────────────────────────────────────

const protocolSchema = z
  .object({
    /** Pin the run to one protocol version; absent ⇒ adopt the negotiated one. */
    protocolVersion: z.enum(MCP_PROTOCOL_VERSIONS).optional(),
  })
  .passthrough(); // project/guest fields pass through to resolveHostedHttpConfig

conformanceWeb.post("/protocol", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(c, bearerToken, body);
    const parsed = parseWithSchema(protocolSchema, body);

    try {
      const { result } = await runProtocolConformance({
        ...resolved,
        protocolVersion: parsed.protocolVersion,
      });
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /apps ──────────────────────────────────────────────────────────

conformanceWeb.post("/apps", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const config = await resolveHostedServerConfig(c, bearerToken, body);

    try {
      const { result } = await runAppsConformance(config);
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /tasks ─────────────────────────────────────────────────────────

/**
 * Tasks conformance provokes a real task and polls it to a terminal status,
 * all inside this single request — the runner opens its own ephemeral client,
 * so it needs no long-lived connection.
 *
 * Fitting that into the hosted budget takes three bounds, not one. Capping the
 * poll window alone leaves connect, `tools/list` and the provoking
 * `tools/call` free to burn a full `WEB_CALL_TIMEOUT_MS` *each* before polling
 * even starts, so the request could run for minutes:
 *
 * - `HOSTED_TASKS_CALL_TIMEOUT_MS` bounds each individual MCP leg, replacing
 *   the route-wide `WEB_CALL_TIMEOUT_MS` this run's config would otherwise
 *   carry.
 * - `HOSTED_TASKS_POLL_TIMEOUT_MS` bounds the poll window regardless of what
 *   the caller asks for.
 * - `HOSTED_TASKS_DEADLINE_MS` bounds the *whole* run, so however the legs
 *   compose, the route answers with a 504 instead of hanging past the budget.
 *   The abandoned run still unwinds on its own — every leg inside it is
 *   bounded by the per-call timeout — so its ephemeral client is closed by
 *   `withEphemeralClient`'s own teardown shortly after.
 */
const HOSTED_TASKS_POLL_TIMEOUT_MS = 20_000;
/** Per-MCP-call ceiling inside a hosted tasks run (connect, list, call). */
const HOSTED_TASKS_CALL_TIMEOUT_MS = 10_000;
/** Wall-clock ceiling for the whole run, held just under the call budget. */
const HOSTED_TASKS_DEADLINE_MS = WEB_CALL_TIMEOUT_MS - 2_000;

const tasksSchema = z
  .object({
    /** Tool used to provoke a task; required on the extension wire, where
     *  tools carry no task metadata to pick from. */
    toolName: z.string().min(1).optional(),
    toolArguments: z.record(z.string(), z.unknown()).optional(),
    pollTimeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .passthrough(); // project/guest fields pass through to resolveHostedServerConfig

conformanceWeb.post("/tasks", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const config = await resolveHostedServerConfig(c, bearerToken, body);
    const parsed = parseWithSchema(tasksSchema, body);

    try {
      const result = await withHostedDeadline(
        runTasksConformance({
          ...config,
          timeout: HOSTED_TASKS_CALL_TIMEOUT_MS,
          ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
          ...(parsed.toolArguments
            ? { toolArguments: parsed.toolArguments }
            : {}),
          pollTimeoutMs: Math.min(
            parsed.pollTimeoutMs ?? HOSTED_TASKS_POLL_TIMEOUT_MS,
            HOSTED_TASKS_POLL_TIMEOUT_MS
          ),
        }),
        HOSTED_TASKS_DEADLINE_MS,
        `Tasks conformance exceeded the hosted request budget (${HOSTED_TASKS_DEADLINE_MS}ms); run it from the local inspector for a longer poll window`
      ).then((r) => r.result);
      return { success: true, result };
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /oauth/start ───────────────────────────────────────────────────

const oauthStartSchema = z
  .object({
    oauthProfile: oauthConformanceProfileSchema.optional(),
    callbackOrigin: z.string().optional(),
  })
  .passthrough(); // project/guest fields pass through to resolveHostedHttpConfig

conformanceWeb.post("/oauth/start", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = await readJsonBody<Record<string, unknown>>(c);
    const resolved = await resolveHostedHttpConfig(c, bearerToken, body);
    const parsed = parseWithSchema(oauthStartSchema, body);

    if (!parsed.callbackOrigin) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "callbackOrigin is required to run OAuth conformance"
      );
    }

    // The profile's `serverUrl` OVERRIDES the Convex-resolved one inside the
    // suite, so authorizing the server row is not enough — this string is
    // caller-controlled and must clear the same bar.
    if (parsed.oauthProfile?.serverUrl) {
      await assertConformanceTarget(
        parsed.oauthProfile.serverUrl,
        "OAuth profile server URL"
      );
    }

    try {
      return await startOAuthConformance({
        defaultServerUrl: resolved.serverUrl,
        defaultCustomHeaders: resolved.customHeaders,
        redirectUrl: `${parsed.callbackOrigin.replace(
          /\/$/,
          ""
        )}/oauth/callback/debug`,
        oauthProfile: parsed.oauthProfile,
      });
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── POST /oauth/authorize ───────────────────────────────────────────────

const oauthAuthorizeSchema = z.object({
  sessionId: z.string().min(1),
  code: z.string().min(1),
  state: z.string().optional(),
});

conformanceWeb.post("/oauth/authorize", async (c) =>
  handleRoute(c, async () => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    const parsed = parseWithSchema(oauthAuthorizeSchema, body);

    const delivered = submitOAuthConformanceCode(parsed);
    if (!delivered) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Session not found or not waiting for authorization"
      );
    }
    return { success: true };
  })
);

// ── POST /oauth/complete ────────────────────────────────────────────────

const oauthCompleteSchema = z.object({
  sessionId: z.string().min(1),
});

conformanceWeb.post("/oauth/complete", async (c) =>
  handleRoute(c, async () => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    const parsed = parseWithSchema(oauthCompleteSchema, body);
    try {
      return await completeOAuthConformance(parsed);
    } catch (error) {
      throw toWebError(error);
    }
  })
);

// ── Directory readiness (hosted, durable, optionally billed) ────────────

/**
 * The conformance panel's readiness surface.
 *
 * These are the SAME runs `/api/v1` starts, against the same table and the
 * same lease — the shared starter in `routes/shared/readiness-runs.ts` is what
 * guarantees that, rather than a comment promising it. What differs here is
 * only the credential: the panel holds a session bearer, not an API key.
 *
 * WHY A START RETURNS A RUN ID INSTEAD OF A RESULT. Every other route in this
 * file finishes inside the hosted budget and answers with a grade. A readiness
 * run cannot: it walks a redirect chain, discovers authorization metadata,
 * lists tools, and — when the caller asked — waits on a model. Holding the
 * request open would make the browser's timeout the run's timeout, and a tab
 * closed at the wrong moment would strand a lease nobody reclaims until the
 * recovery cron notices.
 *
 * GUESTS ARE REFUSED, and not for rate-limiting reasons. A hosted run bills to
 * a project's organization and writes a durable row that organization owns; a
 * guest identity is free to mint and belongs to no organization, so there is
 * no honest answer to "who pays for this and who owns the result".
 */

/** How long the service-token read of a report blob may take. */
const REPORT_FETCH_TIMEOUT_MS = 30_000;

/** Refuse a guest before anything is created, charged or dialled. */
function assertNotGuest(c: any): void {
  if (c.get("guestId")) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Directory readiness runs belong to a project and bill to its organization. Sign in to run one.",
    );
  }
}

const readinessStartSchema = z
  .object({
    /**
     * Opt in to model-backed observations, which SPEND MCPJam credits.
     *
     * Defaults to false here and everywhere else. Defaulting it on would make
     * every existing caller start paying on the day this shipped, which is the
     * one behaviour a billed opt-in may not have.
     */
    includeLlmObservations: z.boolean().optional(),
    /**
     * The DECLARED submission shape. Required for OpenAI, never inferred.
     *
     * Inference reads a forgotten package as "MCP-only", which reports the
     * package lane `not-applicable` — turning a missing input into a clean
     * bill of health, which is the exact failure `incomplete` exists to
     * prevent.
     */
    submissionMode: z.enum(HOSTED_SUBMISSION_MODES).optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough(); // project/server fields pass through to authorizeServer

function readinessPublisher(c: any): ReadinessPublisher {
  const publisher = c.req.param("publisher");
  if (publisher !== "claude" && publisher !== "openai") {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "publisher must be claude or openai",
    );
  }
  return publisher;
}

conformanceWeb.post("/readiness/:publisher", async (c) =>
  handleRoute(
    c,
    async () => {
      assertNotGuest(c);
      const publisher = readinessPublisher(c);
      const bearerToken = assertBearerToken(c);
      const body = await readJsonBody<Record<string, unknown>>(c);
      const parsed = parseWithSchema(readinessStartSchema, body);

      if (publisher === "openai" && !parsed.submissionMode) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "An OpenAI readiness run must declare its submission mode; it is never inferred from the inputs supplied.",
        );
      }

      const wsBody = parseWithSchema(projectServerSchema, body);
      const authorized = await authorizeServer(
        c,
        bearerToken,
        wsBody.projectId,
        wsBody.serverId,
        {
          accessScope: wsBody.accessScope,
          scenarioId: wsBody.scenarioId,
          accessVersion: wsBody.accessVersion,
        },
      );

      // The same egress guard every other hosted conformance target passes.
      // The URL came from the saved row rather than the body, but "we picked
      // it" is not "it is safe": a row can name a private address, and this is
      // the only place that is checked before a socket is opened.
      if (authorized.serverConfig.url) {
        await assertConformanceTarget(authorized.serverConfig.url, "Server URL");
      }

      const receipt = await startHostedReadinessRun({
        convex: createReadinessConvexClient(bearerToken),
        projectId: wsBody.projectId,
        serverId: wsBody.serverId,
        publisher,
        submissionMode: parsed.submissionMode,
        idempotencyKey: parsed.idempotencyKey,
        includeLlmObservations: parsed.includeLlmObservations === true,
        authorized,
        translateError: (error) => toWebError(error),
      });
      return { success: true, run: receipt };
    },
    202,
  ),
);

conformanceWeb.get("/readiness/runs/:runId", async (c) =>
  handleRoute(c, async () => {
    assertNotGuest(c);
    const bearerToken = assertBearerToken(c);
    const runId = c.req.param("runId");
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "projectId is required",
      );
    }

    // Authorization is the QUERY's job, not ours: `getReadinessRun` runs
    // `requireProjectRole` under the caller's own identity against the run's
    // real project. Checking the caller-supplied `projectId` here instead
    // would be checking a claim against itself.
    let run: Record<string, any> | null;
    try {
      run = await createReadinessConvexClient(bearerToken).query(
        "claudeReadinessRuns:getReadinessRun" as any,
        { runId },
      );
    } catch (error) {
      throw toWebError(error);
    }
    if (!run) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Readiness run not found");
    }
    return { success: true, run: toReadinessRunDto(run, { projectId }) };
  }),
);

conformanceWeb.post("/readiness/runs/:runId/cancel", async (c) =>
  handleRoute(c, async () => {
    assertNotGuest(c);
    const bearerToken = assertBearerToken(c);
    const runId = c.req.param("runId");
    try {
      await createReadinessConvexClient(bearerToken).mutation(
        "claudeReadinessRuns:cancelReadinessRun" as any,
        { runId },
      );
    } catch (error) {
      throw toWebError(error);
    }
    // The executing node learns about this on its next heartbeat, which
    // answers `alive: false` and aborts the run in flight. That matters more
    // than the row's status: the thing being stopped is traffic to somebody
    // else's server.
    return { success: true, runId, status: "cancelled" as const };
  }),
);

/**
 * The stored report, double-gated.
 *
 * The panel needs per-finding detail, and the run row deliberately does not
 * carry it — a row that inlined every finding would be a document, not a row,
 * and listing ten runs would ship ten documents.
 *
 * TWO GATES, not one. The query below runs `requireProjectRole` under the
 * CALLER's identity, so reaching the fetch already proves access; the blob
 * itself can only be read from inside Convex, so the bytes come back over the
 * service-token route — which takes a RUN id rather than a blob id, precisely
 * so this node cannot use it to read blobs belonging to other features. A
 * single service-token read keyed on a caller-supplied id would serve any
 * organization's report to any signed-in user.
 */
conformanceWeb.get("/readiness/runs/:runId/report", async (c) => {
  try {
    assertNotGuest(c);
    const bearerToken = assertBearerToken(c);
    const runId = c.req.param("runId");

    let blobId: string | null;
    try {
      blobId = await createReadinessConvexClient(bearerToken).query(
        "claudeReadinessRuns:getReadinessReportBlobId" as any,
        { runId },
      );
    } catch (error) {
      throw toWebError(error);
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

    const { convexUrl, serviceToken } = getInternalBackendConfig();
    let response: Response;
    try {
      response = await fetch(
        `${convexUrl}/internal/v1/claude-readiness/runs/report?runId=${encodeURIComponent(runId)}`,
        {
          headers: { "x-inspector-service-token": serviceToken },
          // Without a deadline this fetch inherits none: a backend that
          // accepts the socket and then stalls holds the browser's request
          // open indefinitely.
          signal: AbortSignal.timeout(REPORT_FETCH_TIMEOUT_MS),
        },
      );
    } catch (error) {
      // Reported before it is flattened. A network fault, the 30-second
      // deadline and a refused connection are operationally distinct — a
      // misconfiguration, a report that is merely slow, and a backend that is
      // down — and a user saying "the report could not be loaded" leaves no
      // trace to tell them apart otherwise. `mcpjam_internal`, because none of
      // them is the graded server's doing.
      reportRouteFailure("[readiness] report blob read failed", error, {
        source: "readiness.report_fetch",
        hop: "mcpjam_internal",
        context: { runId },
      });
      throw new WebRouteError(
        502,
        ErrorCode.INTERNAL_ERROR,
        "The readiness report could not be read from storage.",
      );
    }
    if (!response.ok) {
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
    // Streamed rather than buffered: a readiness report carries per-finding
    // evidence and can reach megabytes, and holding one in memory per
    // concurrent reader is a cost with no upside.
    return new Response(response.body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    // Not `handleRoute`: the success path returns raw bytes rather than a JSON
    // envelope, so the error path has to reach the same mapper on its own.
    return webErrorFromRoute(c, toWebError(error));
  }
});

export default conformanceWeb;
