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
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import {
  createJourneyRun,
  SwarmAgentError,
  type PinnedHostExecutionSpec,
} from "../../services/swarm-agent.js";
import { startJourneyRun } from "../../services/sessionSimulation/swarm-runner.js";
import { logger } from "../../utils/logger.js";

const swarmRuns = new Hono();

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

  // Timeout: accept either wire spelling (`timeoutMs` on the resolver shape,
  // `requestTimeout` on the project-config shape); require a positive finite
  // number, else fall back to the live default.
  const rawTimeout = defaults?.timeoutMs ?? defaults?.requestTimeout;
  const timeoutMs =
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : fallbackTimeoutMs;

  const initializePins: NonNullable<
    PinnedConnectionSettings["initializePins"]
  > = {};
  const clientInfo = asRecord(defaults?.clientInfo);
  if (clientInfo) {
    initializePins.clientInfo = clientInfo as {
      name?: string;
      version?: string;
    } & Record<string, unknown>;
  }
  if (Array.isArray(defaults?.supportedProtocolVersions)) {
    const versions = defaults.supportedProtocolVersions.filter(
      (v): v is string => typeof v === "string"
    );
    if (versions.length > 0) {
      initializePins.supportedProtocolVersions = versions;
    }
  }
  const batchProtocol = coerceProtocolVersion(defaults?.mcpProtocolVersion);
  if (batchProtocol) {
    initializePins.mcpProtocolVersion = batchProtocol;
  }

  // Per-server protocol pins from the pinned overrides. Accept both the
  // resolver key (`mcpProtocolVersion`) and the project-config key
  // (`mcpProtocolVersionOverride`); createAuthorizedManager re-validates.
  const overrides = asRecord(host.serverConnectionOverrides);
  let mcpProtocolVersionsByServerId: Record<string, McpProtocolVersion> | undefined;
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
    }
  }

  return {
    timeoutMs,
    ...(Object.keys(initializePins).length > 0 ? { initializePins } : {}),
    ...(mcpProtocolVersionsByServerId
      ? { mcpProtocolVersionsByServerId }
      : {}),
  };
}

/**
 * Launch a hidden single-host swarm (journey-execution) run (PR 3c).
 *
 * Creates a journey run capped to a single host (`maxHosts: 1` — a multi-host
 * journey is rejected transactionally before any run row exists), then starts
 * the runner fire-and-forget and returns HTTP 202 with the runId. The Run
 * button in the UI stays DISABLED; this route is the only way to exercise the
 * slice until fan-out (PR 3d).
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

      // Create the run capped to a single host. A journey with >1 host is
      // rejected transactionally BEFORE any run row is created — surface the
      // backend's 4xx as a clear client error instead of a bare 500.
      let created;
      try {
        created = await createJourneyRun(convexHttpUrl, bearerToken, {
          journeyRefId: journeyId,
          launchKey: body.launchKey,
          maxHosts: 1,
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
            err.bodyText ||
              "This journey can't be launched by the single-host runner (it may have more than one host)."
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
      if (!Array.isArray(snapshot.hosts) || snapshot.hosts.length !== 1) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "The single-host runner requires exactly one pinned host"
        );
      }
      const host = snapshot.hosts[0]!;
      // Connect ONLY the pinned required servers (optionalServerIds stay off,
      // matching a real no-opt-in visitor's session).
      const serverIds = host.serverIds;
      // Reconnect with the snapshot's non-secret connection settings (timeout +
      // protocol pins) so the run is reproducible — NOT whatever the host's
      // current live config would negotiate. Secrets/headers stay live-resolved.
      const connection = buildPinnedConnectionSettings(
        host,
        WEB_STREAM_TIMEOUT_MS
      );

      setImmediate(() => {
        startJourneyRun({
          runId,
          projectId,
          host,
          personaSnapshot: snapshot.personaSnapshot,
          sessionsPerHost: snapshot.sessionsPerHost,
          maxTurns: snapshot.maxTurns,
          convexHttpUrl,
          bearer: bearerToken,
          authHeader,
          managerFactory: async () => {
            const { manager } = await createAuthorizedManager(
              callerContextFromHono(c),
              bearerToken,
              projectId,
              serverIds,
              connection.timeoutMs,
              undefined,
              undefined,
              {
                accessScope: "project_member",
                ...(connection.initializePins
                  ? { initializePins: connection.initializePins }
                  : {}),
                ...(connection.mcpProtocolVersionsByServerId
                  ? {
                      mcpProtocolVersionsByServerId:
                        connection.mcpProtocolVersionsByServerId,
                    }
                  : {}),
              }
            );
            return {
              manager,
              connectedServerIds: serverIds,
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
