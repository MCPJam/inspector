import { Hono } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  createAuthorizedManager,
  callerContextFromHono,
} from "./auth.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import {
  createJourneyRun,
  SwarmAgentError,
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
      const bearerToken = assertBearerToken(c);
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
      const authHeader = c.req.header("authorization");
      if (!authHeader) {
        throw new WebRouteError(
          401,
          ErrorCode.UNAUTHORIZED,
          "Authorization header required"
        );
      }

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

      // The backend derives + authorizes projectId from the journey. Guard the
      // client-supplied projectId against it so a mistargeted launch fails loud.
      if (created.projectId !== body.projectId) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "projectId does not match the journey's project"
        );
      }

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
              WEB_STREAM_TIMEOUT_MS,
              undefined,
              undefined,
              { accessScope: "project_member" }
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
