import { Hono } from "hono";
import { z } from "zod";
import { isKnownProtocolVersion, type McpProtocolVersion } from "@mcpjam/sdk";
import {
  ErrorCode,
  WebRouteError,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  createAuthorizedManager,
  callerContextFromHono,
} from "./auth.js";
import { xaaPolicyFromMcpProfile } from "../../utils/effective-auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { WEB_STREAM_TIMEOUT_MS, HOSTED_MODE } from "../../config.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import {
  createJourneyRun,
  SwarmAgentError,
  type PinnedHostExecutionSpec,
} from "../../services/swarm-agent.js";
import {
  getRunningJourneyStreamHub,
  startJourneyRun,
} from "../../services/sessionSimulation/swarm-runner.js";
import { resolveTargetPluginServerIds } from "../../services/journeys/plugin-servers.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import type { SwarmStreamEvent } from "../../../shared/swarm-stream-events.js";
import { logger } from "../../utils/logger.js";
import { assertBearerToken } from "./errors.js";

const swarmRuns = new Hono();

const sseEncoder = new TextEncoder();

function encodeSseEvent(event: SwarmStreamEvent): Uint8Array {
  return sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Multiplexed live stream for one journey run. Late joiners receive the
 * in-memory ring buffer then live events until `run_complete`.
 */
swarmRuns.get("/runs/:runId/stream", async (c) => {
  assertBearerToken(c);
  const runId = c.req.param("runId");
  if (!runId) {
    throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "runId required");
  }

  const hub = getRunningJourneyStreamHub(runId);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!hub) {
        // Run already finished (or never started on this process). Clients
        // fall back to Convex + blobs for history.
        try {
          controller.enqueue(
            encodeSseEvent({
              type: "run_complete",
              runId,
              hostId: "",
              chatSessionId: "",
              sessionIndex: -1,
            })
          );
          controller.close();
        } catch {
          // ignore
        }
        return;
      }

      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      unsubscribe = hub.subscribe((event) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseEvent(event));
          if (event.type === "run_complete") {
            close();
          }
        } catch {
          close();
        }
      });

      c.req.raw.signal.addEventListener("abort", close, { once: true });
    },
  });

  return c.body(stream as any, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
});

function requireConvexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  return url;
}

const startRunSchema = z.object({
  projectId: z.string().min(1),
  launchKey: z.string().min(1),
});

/**
 * Non-secret connection settings threaded into the manager for a pinned host
 * so a swarm run reconnects with the SAME transport behavior the snapshot
 * captured (per-request timeout + MCP protocol pins) rather than whatever the
 * host's CURRENT live config negotiates. Headers / credentials are deliberately
 * EXCLUDED — those stay live-resolved by the authorize batch (a run must use
 * fresh secrets, not a stale snapshot). Every field is read defensively: the
 * pinned `connectionDefaults` / `serverConnectionOverrides` are opaque
 * (`Record<string, unknown>`) snapshot blobs, so a malformed or absent value
 * simply falls back to the live default and never breaks the launch.
 */
interface PinnedConnectionSettings {
  timeoutMs: number;
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: McpProtocolVersion;
  };
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  /**
   * Per-server request-timeout pins (ms) from the snapshot's
   * `serverConnectionOverrides[serverId].requestTimeoutOverride`. A server
   * absent from this map uses the host-level `timeoutMs`.
   */
  requestTimeoutByServerId?: Record<string, number>;
}

function coerceTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coerceProtocolVersion(value: unknown): McpProtocolVersion | undefined {
  return typeof value === "string" && isKnownProtocolVersion(value)
    ? value
    : undefined;
}

function buildPinnedConnectionSettings(
  host: PinnedHostExecutionSpec,
  fallbackTimeoutMs: number
): PinnedConnectionSettings {
  const defaults = asRecord(host.connectionDefaults);

  // Timeout: read from the (scrubbed) `connectionDefaults` — the ONLY field the
  // backend retains there is `requestTimeout` (header values are stripped).
  // Accept either wire spelling defensively; require a positive finite number,
  // else fall back to the live default.
  const timeoutMs =
    coerceTimeoutMs(defaults?.timeoutMs ?? defaults?.requestTimeout) ??
    fallbackTimeoutMs;

  // INITIALIZE pins come from the pinned `mcpProfile`, NOT `connectionDefaults`.
  // The backend's `materializeHostSpec` copies the host's `mcpProfile` verbatim
  // (`mcpProtocolVersion` + `initialize.{clientInfo,supportedProtocolVersions}`)
  // and scrubs `connectionDefaults` down to just `{ requestTimeout }`, so reading
  // the pins from `connectionDefaults` (the old behavior) always found nothing.
  const initializePins: NonNullable<
    PinnedConnectionSettings["initializePins"]
  > = {};
  const initialize = asRecord(host.mcpProfile?.initialize);
  const clientInfo = asRecord(initialize?.clientInfo);
  if (clientInfo) {
    initializePins.clientInfo = clientInfo as {
      name?: string;
      version?: string;
    } & Record<string, unknown>;
  }
  if (Array.isArray(initialize?.supportedProtocolVersions)) {
    const versions = initialize.supportedProtocolVersions.filter(
      (v): v is string => typeof v === "string"
    );
    if (versions.length > 0) {
      initializePins.supportedProtocolVersions = versions;
    }
  }
  const batchProtocol = coerceProtocolVersion(
    host.mcpProfile?.mcpProtocolVersion
  );
  if (batchProtocol) {
    initializePins.mcpProtocolVersion = batchProtocol;
  }

  // Per-server protocol pins from the pinned overrides. Accept both the
  // resolver key (`mcpProtocolVersion`) and the project-config key
  // (`mcpProtocolVersionOverride`); createAuthorizedManager re-validates.
  const overrides = asRecord(host.serverConnectionOverrides);
  let mcpProtocolVersionsByServerId:
    | Record<string, McpProtocolVersion>
    | undefined;
  let requestTimeoutByServerId: Record<string, number> | undefined;
  if (overrides) {
    for (const [serverId, rawOverride] of Object.entries(overrides)) {
      const override = asRecord(rawOverride);
      if (!override) continue;
      const pin = coerceProtocolVersion(
        override.mcpProtocolVersion ?? override.mcpProtocolVersionOverride
      );
      if (pin) {
        mcpProtocolVersionsByServerId ??= {};
        mcpProtocolVersionsByServerId[serverId] = pin;
      }
      // Per-server request-timeout pin. Accept both the resolver spelling
      // (`requestTimeout`) and the project-config override spelling
      // (`requestTimeoutOverride`); a malformed value is simply skipped so the
      // server falls back to the host-level timeout.
      const perServerTimeout = coerceTimeoutMs(
        override.requestTimeoutOverride ?? override.requestTimeout
      );
      if (perServerTimeout !== undefined) {
        requestTimeoutByServerId ??= {};
        requestTimeoutByServerId[serverId] = perServerTimeout;
      }
    }
  }

  return {
    timeoutMs,
    ...(Object.keys(initializePins).length > 0 ? { initializePins } : {}),
    ...(mcpProtocolVersionsByServerId ? { mcpProtocolVersionsByServerId } : {}),
    ...(requestTimeoutByServerId ? { requestTimeoutByServerId } : {}),
  };
}

/**
 * Launch a multi-host swarm (journey-execution) run (PR 3d).
 *
 * Creates a journey run (the backend pins the journey's full host set — no
 * `maxHosts` cap; a backend rejection such as a hard host-count ceiling or a
 * journey with no hosts surfaces as a 4xx), then starts the fan-out runner
 * fire-and-forget and returns HTTP 202 with the runId. This is the route the
 * enabled "Run journey" button in the UI calls.
 */
swarmRuns.post("/journeys/:journeyId/runs", async (c) =>
  handleRoute(
    c,
    async () => {
      // `/journey-execution/*` (like every Convex HTTP action) is JWT-only.
      // A WorkOS API-key caller (`sk_…`) accepted by the route middleware has
      // no usable JWT, so forward the delegated short-lived JWT the rest of the
      // `/api/v1`-reachable surface uses — `getConvexBearerForRequest` returns
      // the original bearer verbatim for session/guest JWTs and mints a
      // delegated JWT for API-key callers. Without this, an API-key launch
      // forwards the raw `sk_…` and every downstream action 401s.
      const bearerToken = await getConvexBearerForRequest(c);
      // The drain + transcript persist forward this same bearer; build the
      // header from the resolved JWT so the API-key path works there too.
      const authHeader = `Bearer ${bearerToken}`;
      const journeyId = c.req.param("journeyId");
      if (!journeyId) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "journeyId required"
        );
      }
      const body = parseWithSchema(
        startRunSchema,
        await readJsonBody<unknown>(c)
      );
      const convexHttpUrl = requireConvexHttpUrl();

      // Create the run over the journey's full pinned host set (no maxHosts
      // cap). A backend rejection (a hard host-count ceiling, a journey with no
      // hosts, a duplicate launchKey, …) surfaces as a clear 4xx instead of a
      // bare 500.
      let created;
      try {
        created = await createJourneyRun(convexHttpUrl, bearerToken, {
          projectId: body.projectId,
          journeyRefId: journeyId,
          launchKey: body.launchKey,
        });
      } catch (err) {
        if (
          err instanceof SwarmAgentError &&
          err.status >= 400 &&
          err.status < 500
        ) {
          throw new WebRouteError(
            err.status,
            ErrorCode.VALIDATION_ERROR,
            err.bodyText || "This journey can't be launched."
          );
        }
        throw err;
      }

      // The backend derives + authorizes projectId from the journey (and is
      // LAUNCHER + project-member gated) — that is the authoritative gate. We do
      // NOT re-check the client-supplied `body.projectId` here: a post-create
      // reject would leave a durable run row with no runner (an orphan). Trust
      // the backend's gating and always proceed to start the runner on a
      // successful create.
      const { runId, projectId, snapshot } = created;

      // Deduped launch (launchKey replay onto an EXISTING run): the ORIGINAL
      // launch's runner owns that run. Starting a second runner here would
      // race it — duplicate claims (suppressed per-attempt by `applied:false`)
      // and, worse, the duplicate's shutdown/cleanup (finalize-pending, abort
      // finalizers, heartbeat stop) can kill attempts the owner is still
      // executing. Acknowledge idempotently with the SAME runId and start
      // nothing. If the original runner is dead, the backend stale-run cron
      // finalizes the run; a retry then needs a FRESH launchKey.
      if (created.deduped) {
        logger.info("[swarm-runs] deduped launch — runner already owns run", {
          runId,
          projectId,
        });
        return { runId, deduped: true };
      }

      if (!Array.isArray(snapshot.hosts) || snapshot.hosts.length === 0) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "This journey has no pinned hosts to run"
        );
      }
      const hosts = snapshot.hosts;

      // Resolve the MCPJam test-IdP issuer NOW, while the request `Context` is
      // still live (it reads `x-forwarded-proto` off `c`). `createAuthorized
      // Manager` fails closed for a `useXaa` server unless `options.xaaIssuer`
      // is present, so a pinned host with a Cross-App-Access server would 500 in
      // the manager factory without this. Resolved eagerly and captured so the
      // fire-and-forget factory (which runs after the 202) doesn't depend on a
      // possibly-finalized Context.
      const xaaIssuer = resolveXaaIssuer(c, HOSTED_MODE);

      // One client for the run's D2 re-gates, built LAZILY on first use.
      // `managerFactory` runs once per SESSION attempt, so constructing per
      // call would be wasteful — but constructing EAGERLY here is worse:
      // `createConvexClient` throws when `CONVEX_URL` is unset, and we are past
      // `createJourneyRun`, where any throw orphans a durable run with no
      // runner (see the comment above). Memoized thunk gets both: at most one
      // client per run, and none at all for a journey that pins no plugins.
      let pluginRegateClient: ReturnType<typeof createConvexClient> | undefined;
      const getPluginRegateClient = () =>
        (pluginRegateClient ??= createConvexClient(bearerToken));

      setImmediate(() => {
        startJourneyRun({
          runId,
          projectId,
          hosts,
          personaSnapshot: snapshot.personaSnapshot,
          sessionsPerHost: snapshot.sessionsPerHost,
          maxTurns: snapshot.maxTurns,
          convexHttpUrl,
          bearer: bearerToken,
          authHeader,
          // Host-aware: each host connects ONLY its own pinned required servers
          // (optionalServerIds stay off, matching a real no-opt-in visitor).
          managerFactory: async (host) => {
            // Decision D2 — re-gate the target's pinned plugin servers against
            // the LIVE plugin, here at connect time, rather than trusting the
            // snapshot's `pluginServerIds`. That stored list records what was
            // PINNED; a plugin disabled or uninstalled since launch must stop
            // contributing servers even though the snapshot still names them.
            // Throwing fails this target's sessions as a config error — the
            // same treatment an invalid stored xaaPolicy gets — because a
            // silently shrunken server set runs an environment nobody
            // configured.
            //
            // Re-gated per SESSION, not once per target: `managerFactory` is
            // invoked per session attempt, so a plugin uninstalled mid-run
            // stops contributing to the very next session rather than at the
            // next launch. Deliberate — revocation should not wait for a run
            // to finish — at the cost of one query per session.
            const pluginServerIds = await resolveTargetPluginServerIds(
              getPluginRegateClient,
              {
                runId,
                targetId: host.targetId,
                snapshotPluginServerIds: host.pluginServerIds,
              }
            );
            // Deduped union: the backend keeps plugin ids out of `serverIds`,
            // but an overlap would double-connect rather than fail, so guard it.
            const hostServerIds = new Set(host.serverIds);
            const pluginOnlyServerIds = pluginServerIds.filter(
              (id) => !hostServerIds.has(id)
            );
            const serverIds =
              pluginOnlyServerIds.length > 0
                ? [...host.serverIds, ...pluginOnlyServerIds]
                : host.serverIds;
            // Reconnect with THIS host's non-secret connection settings
            // (per-request timeout + MCP protocol pins) so the run reproduces
            // the pinned snapshot rather than the host's current live config.
            // Secrets/headers stay live-resolved by the authorize batch.
            const connection = buildPinnedConnectionSettings(
              host,
              WEB_STREAM_TIMEOUT_MS
            );
            const { manager } = await createAuthorizedManager(
              callerContextFromHono(c),
              bearerToken,
              projectId,
              serverIds,
              connection.timeoutMs,
              undefined,
              // Pinned MCP client capabilities from the snapshot — negotiate
              // INITIALIZE with the SAME capabilities the host declared at
              // run-create time (mirrors the chatbox path), not the current
              // live config's.
              host.clientCapabilities,
              {
                accessScope: "project_member",
                // XAA servers fail closed without the issuer; resolved above
                // from the live request Context.
                xaaIssuer,
                // Enterprise-managed policy from the PINNED host snapshot
                // (server-side, mcpProfile copied verbatim at run-create) —
                // the run reproduces the snapshot's policy, and an invalid
                // stored policy fails the host's sessions as a config error
                // rather than silently un-enforcing.
                xaaPolicy: xaaPolicyFromMcpProfile(host.mcpProfile),
                ...(connection.initializePins
                  ? { initializePins: connection.initializePins }
                  : {}),
                ...(connection.mcpProtocolVersionsByServerId
                  ? {
                      mcpProtocolVersionsByServerId:
                        connection.mcpProtocolVersionsByServerId,
                    }
                  : {}),
                ...(connection.requestTimeoutByServerId
                  ? {
                      requestTimeoutByServerId:
                        connection.requestTimeoutByServerId,
                    }
                  : {}),
              }
            );
            return {
              manager,
              connectedServerIds: serverIds,
              // The session connects these, but `resumeConfig` must never tell
              // a later viewer to reconnect them without re-gating the plugin.
              //
              // Subtract anything ALSO in the host's own `serverIds`: D1 keeps
              // plugin ids out of that list so the overlap should be empty, but
              // the union above already guards for it, and marking such an id
              // non-resumable would strip a legitimately host-pinned server
              // from resume. An id that stands on its own in the host config
              // does not need the plugin to justify reconnecting it.
              ...(pluginOnlyServerIds.length > 0
                ? { nonResumableServerIds: pluginOnlyServerIds }
                : {}),
              dispose: async () => {
                await manager.disconnectAllServers();
              },
            };
          },
        }).catch((err) => {
          logger.error("[swarm-runs] startJourneyRun failed", {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });

      return { runId };
    },
    202
  )
);

export default swarmRuns;
