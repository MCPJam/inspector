import { mockDialForRequest } from "./mock-dial.js";
import { mockTransportOf } from "../../utils/mock-servers.js";
import { Hono } from "hono";
import {
  runServerDoctor,
  suppressFeatureObservation,
  type OAuthFlowSummary,
} from "@mcpjam/sdk";
import {
  HOSTED_MODE,
  WEB_CONNECT_TIMEOUT_MS,
  WEB_SERVER_CHECK_DEADLINE_MS,
} from "../../config.js";
import { withinToolListingBudget } from "../../utils/within-budget.js";
import {
  mapRuntimeError,
  webErrorFromRoute,
  projectServerSchema,
  withEphemeralConnection,
  handleRoute,
  authorizeServer,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  toHttpConfig,
  callerOAuthTokenUnlessRefused,
  runEphemeralConnection,
  mapEphemeralServerFailure,
  projectRouteFailure,
} from "./auth.js";
import {
  attachHostedRpcLogs,
  createHostedRpcLogCollector,
} from "./hosted-rpc-logs.js";
import { buildConnectSuccessEnvelope } from "../../utils/local-server-resolver.js";
import {
  captureHostedOnlyAccountProfiles,
  connectedAccounts,
} from "../../utils/account-profile-capture.js";
import { recordConnectInspection } from "../../services/server-canvas/connect-hook.js";
import { optionalOAuthFlowSummarySchema } from "../../services/server-canvas/oauth-flow-summary.js";
import { widenHostedInitInfoForCanvas } from "../../utils/hosted-canvas-projection.js";
import { resolveServerCanvasRollout } from "../../utils/server-canvas-rollout.js";
import {
  claimCanvasRefresh,
  runCanvasRefresh,
} from "../../services/server-canvas/refresh.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
  assertAllowedHostedTargetUrl,
} from "../../utils/hosted-egress-guard.js";
import { hostedMcpBaseFetch } from "../../utils/hosted-mcp-base-fetch.js";
import {
  projectHostedValidateInitInfo,
  redactHostedDoctorTransportDetail,
} from "../../utils/hosted-doctor-redaction.js";
import { projectHostedConnectFailureLogs } from "../../utils/hosted-connect-failure.js";
import { ErrorCode, WebRouteError } from "./errors.js";
import { resolveEffectiveAuthMethod } from "../../utils/effective-auth.js";

const servers = new Hono();

/** Validate also takes the non-secret summary of a just-finished OAuth flow. */
const validateServerSchema = projectServerSchema.extend({
  oauthFlowSummary: optionalOAuthFlowSummarySchema,
});

// Hosted, a failure is reported like every other MCP route's (MJ-001; see
// `withEphemeralConnection`), and a successful connect's log envelope reports
// received frames by their envelope as well.
servers.post("/validate", async (c) =>
  withEphemeralConnection(
    c,
    validateServerSchema,
    // Hosted, bounded by the Connect button's own deadline (counted from the
    // request's arrival, queue wait included); on expiry the ephemeral
    // connection's cleanup stops the stuck connect.
    (manager, body) =>
      withinToolListingBudget(
        validateServerCore(c, manager, body),
        remainingServerCheckBudget(c.get("serverCheckStartedAt")),
        () => `"${body.serverId}"`,
      ),
    {
      timeoutMs: WEB_CONNECT_TIMEOUT_MS,
      ...(HOSTED_MODE
        ? { redactSuccessLogs: projectHostedConnectFailureLogs }
        : {}),
    },
  ),
);

/**
 * What is left of `WEB_SERVER_CHECK_DEADLINE_MS` for a check that reached the
 * server at `startedAt`. No start time means no server-check middleware ran
 * (outside hosted), and then no deadline.
 */
export function remainingServerCheckBudget(
  startedAt: number | undefined,
  now = Date.now(),
): number | undefined {
  if (startedAt === undefined) return undefined;
  return Math.max(0, WEB_SERVER_CHECK_DEADLINE_MS - (now - startedAt));
}

/**
 * Connect-and-inspect core shared by POST /api/web/servers/validate and the
 * public POST /v1/projects/:projectId/servers/:serverId/validate adapter.
 * Captures the inspection snapshot synchronously while the ephemeral manager is
 * still live — `withManager`'s `finally` disconnects the moment we return,
 * which would race any pending listTools. Only the Convex write is
 * fire-and-forget, so persistence failures don't affect the validate response.
 * (Port of PR #1731's `use-inspection-coordinator`.)
 */
export async function validateServerCore(
  c: any,
  manager: any,
  body: {
    projectId: string;
    serverId: string;
    oauthFlowSummary?: OAuthFlowSummary;
  }
) {
  const bearer: string | undefined = c.req.header("authorization");
  // Asked now so the answer is ready when the tools are listed.
  const canvasRollout = resolveServerCanvasRollout(bearer);
  // The doctor's target check, so a stored URL the hosted inspector will not
  // dial is answered as the caller's to fix (400) rather than as a failed
  // connection. A no-op outside hosted mode.
  const config = manager.getServerConfig?.(body.serverId);
  // A mock's address is a placeholder that resolves nowhere: it is reached
  // through the in-process door as the caller, so there is no target to judge
  // and nothing downstream may read the address.
  const isMock = Boolean(config && mockTransportOf(config));
  const configuredUrl = isMock ? undefined : config?.url;
  if (typeof configuredUrl === "string" || configuredUrl instanceof URL) {
    await assertHostedServerTarget(String(configuredUrl));
  }
  // The Connect button's own listing is not observed use.
  await suppressFeatureObservation(manager, body.serverId, () =>
    manager.getToolsForAiSdk([body.serverId]),
  );
  // Captured before returning: the ephemeral manager disconnects as soon as
  // this function does. Only the Convex write runs after the response. A shared
  // or uploaded account's identity is captured beside the inspection, while
  // the ephemeral manager is still live.
  const [{ canvas }] = await Promise.all([
    recordConnectInspection({
      hosted: true,
      projectId: body.projectId,
      serverId: body.serverId,
      managerKey: body.serverId,
      manager,
      convexBearer: bearer,
      ...(configuredUrl ? { serverUrl: String(configuredUrl) } : {}),
      canvasRollout,
      oauthFlow: body.oauthFlowSummary,
      logPrefix: "hosted-connect-inspection",
    }),
    captureHostedOnlyAccountProfiles(
      manager,
      connectedAccounts(manager, body.serverId),
      {
        bearer: String(c.req?.header?.("authorization") ?? "").replace(
          /^Bearer\s+/i,
          "",
        ),
        projectId: body.projectId,
      },
    ),
  ]);
  // Same success envelope as the local /api/mcp/connect path so the inspector
  // client's `storeInitInfo` takes one code path on both surfaces. Hosted, its
  // initialization info is projected (MJ-001), and widened for the canvas.
  const envelope = buildConnectSuccessEnvelope(manager, body.serverId);
  if (!HOSTED_MODE) return envelope;
  const initInfo = projectHostedValidateInitInfo(envelope.initInfo);
  return {
    ...envelope,
    initInfo: canvas
      ? widenHostedInitInfoForCanvas(
          initInfo,
          envelope.initInfo,
          manager.getCapturedEventsCapability?.(body.serverId)?.rawCapabilities,
        )
      : initInfo,
  };
}

servers.post("/check-oauth", async (c) =>
  handleRoute(c, async () => {
    const rawBody = await readJsonBody<unknown>(c);
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(projectServerSchema, rawBody);
    const auth = await authorizeServer(
      c,
      bearerToken,
      body.projectId,
      body.serverId,
      {
        accessScope: body.accessScope,
        scenarioId: body.scenarioId,
        accessVersion: body.accessVersion,
      }
    );
    return buildOAuthRequirementProjection(auth.serverConfig);
  })
);

/**
 * What a caller asking "does this server need authorizing before I can use
 * it?" must read.
 *
 * `useOAuth` is a DERIVED COMPAT MIRROR of the canonical `authMethod`
 * (mcpjam-backend `deriveAuthBooleans`): an `auto` row that is not
 * XAA-configured is stored with `useOAuth: true` even though `auto` resolves
 * to the discover ladder — connect unauthenticated, and escalate only when the
 * target actually answers 401. So the mirror answers "could this server ever
 * use OAuth", never "must someone authorize it first", and a caller that gates
 * on it demands consent from servers that have no authorization server at all.
 * `requiresAuthorization` is that second question, resolved through the shared
 * connect-time predicate; the mirror stays on the response for existing
 * consumers.
 */
export function buildOAuthRequirementProjection(serverConfig: {
  useOAuth?: boolean;
  url?: string;
  authMethod?: "auto" | "oauth" | "xaa" | "bearer" | "none";
  useXaa?: boolean;
  authServerMode?: "mcpjam" | "own";
  clientId?: string;
}) {
  const effectiveAuthMethod = resolveEffectiveAuthMethod(serverConfig);
  return {
    useOAuth: serverConfig.useOAuth ?? false,
    requiresAuthorization: effectiveAuthMethod === "oauth",
    effectiveAuthMethod,
    serverUrl: serverConfig.url ?? null,
  };
}

servers.post("/doctor", async (c) => {
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;

  try {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    // A hosted doctor response carries only its projected envelope (MJ-001),
    // so the connection's JSON-RPC frames are not collected for it.
    rpcCollector = HOSTED_MODE
      ? undefined
      : createHostedRpcLogCollector(rawBody);
    const timeoutMs = WEB_CONNECT_TIMEOUT_MS;
    const result = await runHostedDoctor(
      c,
      rawBody,
      timeoutMs,
      rpcCollector?.rpcLogger
    );

    return c.json(attachHostedRpcLogs(result, rpcCollector), 200);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webErrorFromRoute(
      c,
      routeError,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined
    );
  }
});

/**
 * Refresh the server canvas: a fresh capture and every background probe for
 * one project server, on an ephemeral connection, behind `server-canvas`.
 * Answers 202 `accepted` once the probes are stored; the page watches Convex
 * for results. Answers 409 `disabled` when the rollout is off, at the gate or
 * when the refresh rechecks it, and an error when the refresh fails. The route
 * holds its server-check slot (the egress limiter in `routes/web/index.ts`)
 * until then. The connection is `runEphemeralConnection`'s: it closes as soon
 * as the probes no longer need it, or when the server-check scope aborts. A
 * second refresh from the same verified caller for the same server while one
 * runs is authorized, then answers 202 and joins it. The body may carry the
 * same client pins as /validate, so the capture lands in the same context as
 * the connect's.
 */
servers.post("/canvas/refresh", async (c) => {
  const claim: { release?: () => void } = {};
  try {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    const body = parseWithSchema(projectServerSchema, rawBody);
    const bearer: string | undefined = c.req.header("authorization");
    assertBearerToken(c);
    if (!(await resolveServerCanvasRollout(bearer))) {
      return c.json({ status: "disabled" }, 409);
    }
    // An unverified passthrough bearer names no principal, so its refresh is
    // not deduped: a shared key would let one member's run swallow another's.
    const caller = c.get("guestId") ?? c.get("workosUserId");
    const run = await runEphemeralConnection(
      c,
      rawBody,
      projectServerSchema,
      async (manager) => {
        const config = manager.getServerConfig(body.serverId);
        if (config && "url" in config && config.url && !mockTransportOf(config)) {
          await assertHostedServerTarget(String(config.url));
        }
        // Claimed once authorized, so only a caller with access joins a run.
        if (caller) {
          claim.release = claimCanvasRefresh({
            caller,
            projectId: body.projectId,
            serverId: body.serverId,
          });
          if (!claim.release) return undefined;
        }
        return runCanvasRefresh({
          hosted: true,
          projectId: body.projectId,
          serverId: body.serverId,
          manager,
          managerKey: body.serverId,
          convexBearer: bearer ?? "",
        });
      },
      { timeoutMs: WEB_CONNECT_TIMEOUT_MS },
    );
    if (!run) return c.json({ status: "accepted" }, 202);
    // The connection is closed by now; the HTTP probes may still be running.
    await run.done;
    if (run.outcome === "rollout-off") {
      return c.json({ status: "disabled" }, 409);
    }
    if (run.outcome === "failed") {
      return webErrorFromRoute(
        c,
        new WebRouteError(
          500,
          ErrorCode.INTERNAL_ERROR,
          "The refresh failed. Try again in a moment.",
        ),
      );
    }
    return c.json({ status: "accepted" }, 202);
  } catch (error) {
    const { routeError } = projectRouteFailure(
      mapEphemeralServerFailure(error),
      error,
      undefined,
    );
    return webErrorFromRoute(c, routeError);
  } finally {
    claim.release?.();
  }
});

export default servers;

/**
 * Refuse a doctor or validate target the hosted inspector must not dial,
 * mapping the two guard outcomes the way the conformance routes do: a blocked
 * address is the caller's problem (400), a resolver failure is ours (503).
 */
async function assertHostedServerTarget(url: string): Promise<void> {
  try {
    await assertAllowedHostedTargetUrl(url, "Server URL");
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    if (error instanceof EgressResolutionError) {
      throw new WebRouteError(503, ErrorCode.SERVER_UNREACHABLE, error.message);
    }
    throw error;
  }
}

export async function runHostedDoctor(
  c: any,
  rawBody: Record<string, unknown>,
  timeoutMs: number,
  rpcLogger?: Parameters<typeof runServerDoctor>[0]["rpcLogger"]
) {
  const bearerToken = assertBearerToken(c);
  const body = parseWithSchema(projectServerSchema, rawBody);
  const auth = await authorizeServer(
    c,
    bearerToken,
    body.projectId,
    body.serverId,
    {
      accessScope: body.accessScope,
      scenarioId: body.scenarioId,
      accessVersion: body.accessVersion,
    }
  );

  // The same rule as the connect builder: a reason the backend gave for
  // withholding the saved token is not something the body's token answers.
  const config = toHttpConfig(
    auth,
    timeoutMs,
    auth.oauthAccessToken ??
      callerOAuthTokenUnlessRefused(
        auth,
        resolveEffectiveAuthMethod(auth.serverConfig),
        body.oauthAccessToken
      ),
    body.clientCapabilities,
    undefined,
    undefined,
    undefined,
    mockDialForRequest(c, bearerToken, body.projectId, body.serverId, body)
  );

  // Judge the target once, before either leg runs — the same check the
  // conformance routes make, and a no-op outside hosted mode. This is the
  // caller-facing refusal: a stored URL that is already a private address gets
  // a 400 naming the host they typed, rather than a transport error.
  // A mock is reached through its in-process door as the caller: no target to
  // judge, and the probes and the connection use the door, never the network.
  const mockDoor = mockTransportOf(config);
  if (!mockDoor) await assertHostedServerTarget(config.url);

  // THE DOCTOR'S TWO LEGS, ON ONE TRANSPORT.
  //
  // `runServerDoctor` probes over `fetchFn`, records a failed probe, and
  // connects anyway — and its connection goes through `withEphemeralClient`,
  // which threads the config's own `baseFetch` into the MCP transport. Both
  // legs dial the pinned transport: resolve once, classify, pin the address
  // into the socket, and re-run all of it on every redirect hop. One transport
  // rather than two so the probe and the connection cannot disagree about what
  // is dialable.
  const doctorFetch = mockDoor ?? hostedMcpBaseFetch();

  const result = await runServerDoctor({
    // A hosted doctor run is not SDK usage, so the SDK sends nothing for it.
    __suppressTelemetry: true,
    config: { ...config, baseFetch: doctorFetch },
    target: {
      kind: "http",
      scope: "hosted",
      projectId: body.projectId,
      serverId: body.serverId,
      label: body.serverName ?? body.serverId,
      ...(auth.serverConfig.url ? { url: auth.serverConfig.url } : {}),
    },
    timeout: timeoutMs,
    rpcLogger,
    // The probe follows two destinations the target names for itself — the RFC
    // 9728 pointer in its challenge and the authorization server that document
    // advertises. The SDK guard classifies IP literals, but only a resolver can
    // catch a hostname that answers with a private address, and only per-hop
    // checking can catch a redirect. Both live here. Outside hosted mode this
    // is the identity function, so localhost and LAN probing is unaffected.
    fetchFn: doctorFetch,
  });

  return redactHostedDoctorTransportDetail(result);
}
