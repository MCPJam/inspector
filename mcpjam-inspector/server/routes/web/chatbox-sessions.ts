import { Hono } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  authorizeBatch,
  createAuthorizedManager,
  withManager,
} from "./auth.js";
import { WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config.js";
import { captureToolSnapshotForEvalAuthoring } from "../../services/evals/route-helpers.js";
import {
  createRun,
  generatePersonas,
  getRun,
  type PersonaSlate,
} from "../../services/session-agent.js";
import { startSimulation } from "../../services/sessionSimulation/runner.js";
import { getRunnerMode } from "../../services/sessionSimulation/durable-runner.js";
import { logger } from "../../utils/logger.js";
import { isMCPJamProvidedModel } from "@/shared/types";

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

// The dialog sends the full chatbox server list and the start route filters
// optionals out, matching what a real visitor with no opt-ins would see.
// Optional-default-off is enforced server-side so a tampered body can't
// quietly widen the synthetic tool set beyond the no-opt-in baseline.
const chatboxServerSchema = z.object({
  serverId: z.string().min(1),
  serverName: z.string().min(1).optional(),
  optional: z.boolean().optional(),
});

const generatePersonasSchema = z.object({
  projectId: z.string().min(1),
  servers: z.array(chatboxServerSchema).min(1),
  personaCount: z.number().int().min(1).max(10),
  accessVersion: z.number().int().nonnegative().optional(),
  // Optional human label for the chatbox surface. Forwarded to the backend
  // as `serverAttachment.name` so generated personas are grounded in the
  // actual product framing instead of inferred from raw tool descriptions.
  chatboxName: z.string().min(1).optional(),
});

const personaSlateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string(),
  notes: z.string(),
});

const startSimulationSchema = z.object({
  projectId: z.string().min(1),
  servers: z.array(chatboxServerSchema).min(1),
  accessVersion: z.number().int().nonnegative().optional(),
  personas: z.array(personaSlateSchema).min(1).max(10),
  sessionsPerPersona: z.number().int().min(1).max(5),
  maxTurns: z.number().int().min(1).max(20),
});

function resolveRequiredServers(
  servers: Array<{ serverId: string; serverName?: string; optional?: boolean }>,
): { selectedServerIds: string[]; selectedServerNames: string[] } {
  const required = servers.filter((s) => s.optional !== true);
  return {
    selectedServerIds: required.map((s) => s.serverId),
    selectedServerNames: required
      .map((s) => s.serverName)
      .filter((n): n is string => typeof n === "string"),
  };
}

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
    const { selectedServerIds, selectedServerNames } = resolveRequiredServers(
      body.servers,
    );
    if (selectedServerIds.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Chatbox has no required servers",
      );
    }

    const result = await withManager(
      createAuthorizedManager(
        c,
        bearerToken,
        body.projectId,
        selectedServerIds,
        WEB_STREAM_TIMEOUT_MS,
        undefined,
        undefined,
        {
          accessScope: "chat_v2",
          chatboxId,
          accessVersion: body.accessVersion,
          serverNames: selectedServerNames,
        },
      ),
      async (manager) => {
        const { toolSnapshot } = await captureToolSnapshotForEvalAuthoring(
          manager,
          selectedServerIds,
          { logPrefix: "session-simulation.generate-personas" },
        );
        const personas = await generatePersonas(
          toolSnapshot,
          convexHttpUrl,
          bearerToken,
          body.projectId,
          chatboxId,
          body.personaCount,
          // Chatbox is a 1:1 attachment surface — id/name come from the
          // chatbox itself; resolvedServerNames mirrors the snapshot's
          // serverIds (no display-name rewrite happens on this pipeline,
          // unlike the eval flow). The backend uses `name` for the prompt
          // label and `resolvedServerNames` for defense-in-depth scoping.
          {
            id: chatboxId,
            ...(body.chatboxName ? { name: body.chatboxName } : {}),
            resolvedServerNames: selectedServerIds,
          },
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

    const { selectedServerIds, selectedServerNames } = resolveRequiredServers(
      body.servers,
    );
    if (selectedServerIds.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Chatbox has no required servers",
      );
    }

    // BYOK guard (plan v4 §H): synthetic runs require an MCPJam-provided
    // model so per-run spend can be attributed to chatboxSynthesisRuns
    // via the /stream usage-record path. Org BYOK chats route through
    // /stream/org with the provider key, which the worker can't
    // re-resolve without the user bearer.
    if (!isMCPJamProvidedModel(runtime.config.modelId)) {
      throw new WebRouteError(
        400,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "Synthetic sessions are not yet supported for chatboxes using your own model keys. Coming soon.",
        { errorCode: "byok_unsupported" },
      );
    }

    // Resolve the worker-safe runtime descriptor (plan v4 §C). This
    // batch authorize round-trip happens while we still hold the
    // user bearer; the result becomes the snapshot the durable worker
    // reads later without any user identity.
    const batch = await authorizeBatch(
      c,
      bearerToken,
      body.projectId,
      selectedServerIds,
      {
        accessScope: "chat_v2",
        chatboxId,
        accessVersion: body.accessVersion,
      },
    );
    const descriptorPerServer: Array<Record<string, unknown>> = [];
    for (const serverId of selectedServerIds) {
      const entry = batch.results[serverId];
      if (!entry?.ok) continue;
      const sc = entry.serverConfig;
      const useOAuth = sc.useOAuth === true;
      descriptorPerServer.push({
        serverId,
        transportType: sc.transportType ?? "http",
        ...(sc.url ? { url: sc.url } : {}),
        ...(sc.headers ? { headers: sc.headers } : {}),
        useOAuth,
        ...(useOAuth && entry.oauthAccessToken
          ? { oauthAccessToken: entry.oauthAccessToken }
          : {}),
      });
    }
    const runtimeDescriptor: Record<string, unknown> = {
      selectedServerIds,
      perServer: descriptorPerServer,
      chatboxConfig: {
        allowedServerIds: selectedServerIds,
        accessVersion: body.accessVersion,
        requireToolApproval: runtime.config.requireToolApproval,
        modelId: runtime.config.modelId,
        modelSource: "mcpjam",
        // Carried so the durable worker can drive the chat loop
        // without re-fetching the chatbox row.
        systemPrompt: runtime.config.systemPrompt,
        ...(typeof runtime.config.temperature === "number"
          ? { temperature: runtime.config.temperature }
          : {}),
        ...(typeof runtime.config.respectToolVisibility === "boolean"
          ? { respectToolVisibility: runtime.config.respectToolVisibility }
          : {}),
        ...(typeof runtime.config.progressiveToolDiscovery === "boolean"
          ? {
              progressiveToolDiscovery:
                runtime.config.progressiveToolDiscovery,
            }
          : {}),
      },
    };

    // workerScope: web route is the hosted-shareable surface, plan §I.
    const { runId } = await createRun(
      convexHttpUrl,
      bearerToken,
      body.projectId,
      chatboxId,
      body.personas as PersonaSlate[],
      body.sessionsPerPersona,
      body.maxTurns,
      { workerScope: "any", runtimeDescriptor },
    );

    const projectId = body.projectId;
    const personas = body.personas as PersonaSlate[];
    const sessionsPerPersona = body.sessionsPerPersona;
    const maxTurns = body.maxTurns;
    const modelId = runtime.config.modelId;
    const systemPrompt = runtime.config.systemPrompt;
    const temperature = runtime.config.temperature;
    const requireToolApproval = runtime.config.requireToolApproval;
    const respectToolVisibility = runtime.config.respectToolVisibility;
    const progressiveToolDiscovery = runtime.config.progressiveToolDiscovery;

    if (getRunnerMode() === "durable") {
      // The pump (boot in `server/app.ts`) claims the freshly-inserted
      // jobs on its next tick. The route returns immediately.
      return { runId };
    }

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
        respectToolVisibility,
        progressiveToolDiscovery,
        convexHttpUrl,
        convexAuthToken: bearerToken,
        authHeader,
        managerFactory: async () => {
          const { manager } = await createAuthorizedManager(
            c,
            bearerToken,
            projectId,
            selectedServerIds,
            WEB_STREAM_TIMEOUT_MS,
            undefined,
            undefined,
            {
              accessScope: "chat_v2",
              chatboxId,
              accessVersion: body.accessVersion,
              serverNames: selectedServerNames,
            },
          );
          return {
            manager,
            connectedServerIds: selectedServerIds,
            connectedServerNames: selectedServerNames,
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
      const chatboxId = c.req.param("chatboxId");
      const runId = c.req.param("runId");
      if (!chatboxId) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "chatboxId required",
        );
      }
      if (!runId) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "runId required",
        );
      }
      const projectId = c.req.query("projectId");
      if (!projectId) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          "projectId required",
        );
      }
      const convexHttpUrl = requireConvexHttpUrl();
      const { run, threadIds } = await getRun(
        convexHttpUrl,
        bearerToken,
        projectId,
        runId,
      );
      // Use 404 (not 403) on mismatch so the response doesn't leak whether
      // the runId exists under a different chatbox.
      if (run.chatboxId !== chatboxId) {
        throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Run not found");
      }
      return { run, threadIds };
    }),
);

export default chatboxSessions;
