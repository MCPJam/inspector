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

// The dialog sends the full chatbox server list and the start route filters
// optionals out, matching what a real visitor with no opt-ins would see.
// Optional-default-off is enforced server-side so a tampered body can't
// quietly widen the synthetic tool set beyond the no-opt-in baseline.
// An empty result (all-optional or no servers attached) is allowed: persona
// generation degrades to surface-name grounding and sessions run toolless,
// the same as a real no-opt-in visitor's chat.
const chatboxServerSchema = z.object({
  serverId: z.string().min(1),
  serverName: z.string().min(1).optional(),
  optional: z.boolean().optional(),
});

const generatePersonasSchema = z.object({
  projectId: z.string().min(1),
  servers: z.array(chatboxServerSchema),
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
  servers: z.array(chatboxServerSchema),
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
    // selectedServerIds may be empty (no required servers): the manager
    // comes back connection-less, the snapshot captures zero servers, and
    // the backend grounds personas in the chatbox name instead of tools.
    const { selectedServerIds, selectedServerNames } = resolveRequiredServers(
      body.servers,
    );

    const result = await withManager(
      createAuthorizedManager(
        callerContextFromHono(c),
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

    // selectedServerIds may be empty (no required servers): the manager
    // factory returns a connection-less manager and the sessions run
    // toolless, exactly like a real no-opt-in visitor's chat.
    const { selectedServerIds, selectedServerNames } = resolveRequiredServers(
      body.servers,
    );

    // BYOK is now supported on synthetic runs: the runner's
    // `drainAssistantTurn` dispatches MCPJam-provided models through
    // `/stream` and org-BYOK models (both cloud and local) through
    // `/stream/org` (or local-usage writeback). The synthesisRunId is
    // stamped onto the resulting llmUsageRecord by each path's backend
    // forwarder so per-run spend rolls up via a query on
    // `llmUsageRecord.synthesisRunId` regardless of model source.
    //
    // The only remaining unsupported case is user-API-key direct (where
    // the request would carry the user's own provider key in the body
    // instead of resolving via org settings). That path doesn't make
    // product sense for synthetic — there's no "visitor" whose key to
    // use — and the chatbox runtime never produces it, so there's no
    // route-level gate to add here.

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
    const respectToolVisibility = runtime.config.respectToolVisibility;
    const progressiveToolDiscovery = runtime.config.progressiveToolDiscovery;
    const builtInToolIds = runtime.config.builtInToolIds;
    const harness = runtime.config.harness;
    // `runtime.config.accessVersion` is the server-resolved value the
    // chatbox redeem produced (vs the client-supplied `body.accessVersion`,
    // which the generate-sessions dialog never sends). Use the runtime
    // value so the runner's /stream/org/resolve and /stream/org body
    // payloads authorize against the right chatbox version. Falling back
    // to body.accessVersion keeps the door open for an explicit client
    // override should the dialog ever start sending one.
    const accessVersion =
      runtime.config.accessVersion ?? body.accessVersion;

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
        ...(builtInToolIds ? { builtInToolIds } : {}),
        ...(harness ? { harness } : {}),
        // Threaded into the runner's per-tool widget snapshot capture so
        // `chatSessions:createWidgetSnapshot` can authenticate against the
        // chatbox path. Without it the Sessions viewer can't render MCP App
        // widgets (e.g. Excalidraw) for synthetic threads.
        ...(accessVersion !== undefined ? { accessVersion } : {}),
        convexHttpUrl,
        convexAuthToken: bearerToken,
        authHeader,
        managerFactory: async () => {
          const { manager } = await createAuthorizedManager(
            callerContextFromHono(c),
            bearerToken,
            projectId,
            selectedServerIds,
            WEB_STREAM_TIMEOUT_MS,
            undefined,
            undefined,
            {
              accessScope: "chat_v2",
              chatboxId,
              // Same reason as the runner-arg fix above: use the
              // server-resolved accessVersion (the dialog doesn't send
              // body.accessVersion) so the manager factory's chatbox
              // access is authorized against the current version.
              accessVersion,
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
