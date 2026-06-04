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
  withManager,
} from "./auth.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config.js";
import { captureToolSnapshotForEvalAuthoring } from "../../services/evals/route-helpers.js";
import {
  generatePersonas,
  getRun,
  type PersonaSlate,
} from "../../services/session-agent.js";
import {
  createRun,
  startSimulation,
} from "../../services/sessionSimulation/runner.js";
import { logger } from "../../utils/logger.js";

const chatboxSessions = new Hono();

function requireConvexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration",
    );
  }
  return url;
}

const generatePersonasSchema = z.object({
  projectId: z.string().min(1),
  selectedServerIds: z.array(z.string().min(1)).min(1),
  selectedServerNames: z.array(z.string().min(1)).optional(),
  personaCount: z.number().int().min(1).max(10),
  accessVersion: z.number().int().nonnegative().optional(),
});

const personaSlateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string(),
  notes: z.string(),
});

const startSimulationSchema = z.object({
  projectId: z.string().min(1),
  selectedServerIds: z.array(z.string().min(1)).min(1),
  selectedServerNames: z.array(z.string().min(1)).optional(),
  accessVersion: z.number().int().nonnegative().optional(),
  personas: z.array(personaSlateSchema).min(1).max(10),
  sessionsPerPersona: z.number().int().min(1).max(5),
  maxTurns: z.number().int().min(1).max(20),
});

chatboxSessions.post("/:chatboxId/generate-personas", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const chatboxId = c.req.param("chatboxId");
    if (!chatboxId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "chatboxId required",
      );
    }
    const body = parseWithSchema(
      generatePersonasSchema,
      await readJsonBody<unknown>(c),
    );
    const convexHttpUrl = requireConvexHttpUrl();

    const result = await withManager(
      createAuthorizedManager(
        c,
        bearerToken,
        body.projectId,
        body.selectedServerIds,
        WEB_STREAM_TIMEOUT_MS,
        undefined,
        undefined,
        {
          accessScope: "chat_v2",
          chatboxId,
          accessVersion: body.accessVersion,
          serverNames: body.selectedServerNames,
        },
      ),
      async (manager) => {
        const { toolSnapshot } = await captureToolSnapshotForEvalAuthoring(
          manager,
          body.selectedServerIds,
          { logPrefix: "session-simulation.generate-personas" },
        );
        const personas = await generatePersonas(
          toolSnapshot,
          convexHttpUrl,
          bearerToken,
          body.projectId,
          chatboxId,
          body.personaCount,
        );
        return { personas };
      },
    );

    return result;
  }),
);

chatboxSessions.post("/:chatboxId/simulate-sessions/start", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const chatboxId = c.req.param("chatboxId");
    if (!chatboxId) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "chatboxId required",
      );
    }
    const body = parseWithSchema(
      startSimulationSchema,
      await readJsonBody<unknown>(c),
    );
    const convexHttpUrl = requireConvexHttpUrl();
    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Authorization header required",
      );
    }

    const runtime = await fetchChatboxRuntimeConfig({
      chatboxId,
      bearer: bearerToken,
    });
    if (!runtime.ok) {
      throw new WebRouteError(
        runtime.status,
        ErrorCode.INTERNAL_ERROR,
        runtime.error,
      );
    }

    const { runId } = await createRun(
      convexHttpUrl,
      bearerToken,
      body.projectId,
      chatboxId,
      body.personas as PersonaSlate[],
      body.sessionsPerPersona,
      body.maxTurns,
    );

    const projectId = body.projectId;
    const personas = body.personas as PersonaSlate[];
    const sessionsPerPersona = body.sessionsPerPersona;
    const maxTurns = body.maxTurns;
    const modelId = runtime.config.modelId;
    const systemPrompt = runtime.config.systemPrompt;
    const temperature = runtime.config.temperature;
    const requireToolApproval = runtime.config.requireToolApproval;

    setImmediate(() => {
      startSimulation({
        runId,
        chatboxId,
        projectId,
        personas,
        sessionsPerPersona,
        maxTurns,
        modelId,
        systemPrompt,
        temperature,
        requireToolApproval,
        convexHttpUrl,
        convexAuthToken: bearerToken,
        authHeader,
        managerFactory: async () => {
          const { manager } = await createAuthorizedManager(
            c,
            bearerToken,
            projectId,
            body.selectedServerIds,
            WEB_STREAM_TIMEOUT_MS,
            undefined,
            undefined,
            {
              accessScope: "chat_v2",
              chatboxId,
              accessVersion: body.accessVersion,
              serverNames: body.selectedServerNames,
            },
          );
          return {
            manager,
            connectedServerIds: body.selectedServerIds,
            dispose: async () => {
              await manager.disconnectAllServers();
            },
          };
        },
      }).catch((err) => {
        logger.error("[chatbox-sessions] startSimulation failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    return { runId };
  }),
);

chatboxSessions.get(
  "/:chatboxId/simulate-sessions/:runId",
  async (c) =>
    handleRoute(c, async () => {
      const bearerToken = assertBearerToken(c);
      const runId = c.req.param("runId");
      if (!runId) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "runId required",
        );
      }
      const convexHttpUrl = requireConvexHttpUrl();
      const { run, threadIds } = await getRun(
        convexHttpUrl,
        bearerToken,
        runId,
      );
      return { run, threadIds };
    }),
);

export default chatboxSessions;
