/**
 * POST /api/v1/projects/:projectId/agent — headless agent turn over the
 * public API.
 *
 * An external caller (first consumer: the MCPJam Slack bot) sends a plain
 * message history; the server runs ONE assistant turn through the shared
 * engine facade (`runUnifiedAssistantTurn`) with a curated set of platform
 * operations as tools, and returns the final assistant text plus references
 * to any resources the turn created. Synchronous JSON — the caller holds
 * conversation state and resends history each turn.
 *
 * Surface decisions (see the Slack-app v1 plan):
 *  - Tools are READ ops + atomic `create_eval_suite` ONLY. Run/cancel ops
 *    (spend eval quota) and `generate_eval_cases` (spends org credits) are
 *    excluded: `approvalMode: "auto-deny"` has no interactive fallback, so
 *    an unattended turn must never spend on the model's own initiative.
 *    Runs stay human-gated caller-side (the Slack "Run it" button posts to
 *    POST /eval-runs directly).
 *  - Every operation is HARD-CLAMPED to the route's `projectId`. The op
 *    catalog's `project` selector allows cross-project roaming for other
 *    surfaces; prompt instructions are not an authorization boundary, so
 *    this adapter overwrites the input and rejects mismatching explicit
 *    values. Org isolation stays enforced by Convex via the delegated JWT.
 *  - The model is pinned server-side (hosted catalog), billed to the
 *    caller's project through the hosted `/stream` rail.
 *  - No chat-session persistence: the caller owns the transcript.
 *  - No tasks seam (the /api/v1 surface refuses task opt-ins by type).
 *
 * Auth plumbing: the caller authenticates with a WorkOS API key (`sk_…`),
 * but BOTH the engine's Convex `/stream` calls and the self-dispatched
 * platform-op calls need a JWT — so the delegated org-scoped JWT minted by
 * `getConvexBearerForRequest` is used for both. Routing the ops through the
 * delegated JWT (not the raw `sk_` key) also keeps the agent's own tool
 * calls out of the caller's per-key rate bucket.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  PlatformApiClient,
  createEvalSuiteOperation,
  getEvalRunOperation,
  getEvalSuiteOperation,
  listEvalCasesOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectServersOperation,
  listServerToolsOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { MCPJAM_HOSTED_ORIGIN, WEB_STREAM_TIMEOUT_MS } from "../../config.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { parseWithSchema } from "../web/errors.js";
import { getSelfFetch } from "../../utils/self-app.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import { resolveTurnRuntime } from "../../utils/resolve-turn-runtime.js";
import { runUnifiedAssistantTurn } from "../../utils/turn-execution.js";
import {
  capForModel,
  toToolError,
} from "../../utils/built-in-tools/mcpjam.js";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import type { ModelDefinition } from "@/shared/types";
import { captureServerEvent } from "../../utils/analytics.js";
import type { RequestLogContext } from "../../utils/log-events.js";
import { logger } from "../../utils/logger.js";
import { v1Error, v1Resource } from "./envelope.js";

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/**
 * The public-agent op list: reads + atomic suite creation. Deliberately NOT
 * derived from the in-app `WORKSPACE_OPERATIONS` set (and deliberately not
 * added to it — `isMcpjamToolId` must keep returning false for
 * `create_eval_suite`, or the in-app chat gate widens).
 */
export const AGENT_API_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, unknown>
> = [
  listProjectServersOperation,
  listServerToolsOperation,
  listEvalSuitesOperation,
  getEvalSuiteOperation,
  listEvalCasesOperation,
  listEvalSuiteRunsOperation,
  getEvalRunOperation,
  createEvalSuiteOperation,
];

export type CreatedResource = {
  type: "eval_suite";
  id: string;
  name?: string;
  url: string;
};

function suiteUrl(suiteId: string): string {
  return `${MCPJAM_HOSTED_ORIGIN}/evals/suite/${encodeURIComponent(suiteId)}`;
}

const PROJECT_SCOPE_ERROR =
  "This agent surface is scoped to a single project; omit the `project` " +
  "argument (it is filled in automatically).";

/**
 * Build the endpoint's ToolSet from the op list: one AI-SDK tool per
 * operation, with (a) the project input clamped to the route's projectId and
 * (b) successful create results collected into `created` BEFORE the
 * model-facing cap can truncate them.
 */
export function buildAgentApiToolSet(opts: {
  client: PlatformApiClient;
  projectId: string;
  created: CreatedResource[];
}): ToolSet {
  const tools: ToolSet = {};
  for (const operation of AGENT_API_OPERATIONS) {
    tools[operation.name] = tool({
      description: `${operation.description} (Scoped to the current project automatically.)`,
      inputSchema: operation.inputSchema,
      execute: async (input: Record<string, unknown>, { abortSignal }) => {
        if (abortSignal?.aborted) {
          return { error: `${operation.title} was cancelled.` };
        }
        // HARD CLAMP: the route's project always wins. An explicit different
        // selector is rejected rather than silently rewritten so the model
        // learns the boundary instead of believing it roamed.
        const requested =
          typeof input.project === "string" ? input.project.trim() : "";
        if (requested && requested !== opts.projectId) {
          return { error: PROJECT_SCOPE_ERROR };
        }
        try {
          const result = await operation.execute(
            { ...input, project: opts.projectId },
            { client: opts.client, signal: abortSignal }
          );
          if (operation.name === createEvalSuiteOperation.name) {
            const suite = (result as { suite?: { id?: string; name?: string } })
              ?.suite;
            if (suite?.id) {
              opts.created.push({
                type: "eval_suite",
                id: suite.id,
                ...(suite.name ? { name: suite.name } : {}),
                url: suiteUrl(suite.id),
              });
            }
          }
          return capForModel(result);
        } catch (error) {
          if (abortSignal?.aborted) {
            return { error: `${operation.title} was cancelled.` };
          }
          return toToolError(error, `${operation.title} failed.`);
        }
      },
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Model + prompt (both static per build, on purpose)
// ---------------------------------------------------------------------------

/**
 * Pinned hosted model. There is no "hosted default" lookup in the catalog —
 * this is an explicit product choice, validated against the live catalog per
 * request so a catalog outage/self-hosted install fails loudly instead of
 * mis-billing.
 */
const AGENT_API_MODEL: ModelDefinition = {
  id: "anthropic/claude-sonnet-5",
  name: "Claude Sonnet 5",
  provider: "anthropic",
  hosted: true,
};

/**
 * Static per build — nothing volatile (no projectId, no timestamp) so the
 * cacheable prompt prefix survives across a conversation's requests. The
 * project boundary is enforced by the tool adapter, not the prompt, so the
 * prompt only needs to SAY it, not carry the id.
 */
const AGENT_API_SYSTEM_PROMPT = [
  "## You are the MCPJam agent",
  "You help users work with their MCPJam project over an API surface (the first host is the MCPJam Slack app). Your specialty is turning conversations into eval suites: reading what the user wants tested, authoring test cases, and creating runnable suites with `create_eval_suite`.",
  "",
  "## Ground rules",
  "- Every operation is automatically scoped to the caller's current project. Omit the `project` argument.",
  "- NEVER invent server names or ids. Call `list_project_servers` first and use exactly what it returns. If no server matches what the user described, ask which server they mean — do not guess and do not fabricate placeholders.",
  "- Before authoring tool-call assertions, check the server's real tool names with `list_server_tools`.",
  "- Author cases as `steps` arrays; prefer a `prompt` step plus `toolCalledWith`-style assertions on the tools the conversation showed. Set `expectedOutput` when the user stated one.",
  `- When creating a suite, set the suite \`model\` explicitly to \`${AGENT_API_MODEL.id}\` unless the user asks for a different model.`,
  "- You CANNOT run suites, and must not claim to. After creating a suite, tell the user it's ready to run and report its id — the surface you're hosted in offers the run action separately.",
  "- Always report the ids of anything you created.",
  "- Consult the MCPJam docs tools (when available) for product questions instead of answering from memory.",
  "- Keep replies concise and concrete. If the request is ambiguous, ask instead of inventing.",
].join("\n");

// ---------------------------------------------------------------------------
// Request/response contract
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_STEPS = 12;
const TURN_WALL_CLOCK_MS = 90_000;
/** In-process per-org concurrent-turn cap (same shape as evals' run cap). */
const MAX_CONCURRENT_TURNS_PER_ORG = 4;

const agentTurnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      })
    )
    .min(1)
    .max(MAX_MESSAGES),
});

const activeTurnsByOrg = new Map<string, number>();

function acquireTurnSlot(key: string): boolean {
  const active = activeTurnsByOrg.get(key) ?? 0;
  if (active >= MAX_CONCURRENT_TURNS_PER_ORG) return false;
  activeTurnsByOrg.set(key, active + 1);
  return true;
}

function releaseTurnSlot(key: string): void {
  const active = activeTurnsByOrg.get(key) ?? 0;
  if (active <= 1) activeTurnsByOrg.delete(key);
  else activeTurnsByOrg.set(key, active - 1);
}

// Docs MCP server: read-only product knowledge, same source as the in-app
// agent. Preflighted below — an outage degrades the turn, never fails it.
const DOCS_SERVER_ID = "mcpjam-docs";
const DEFAULT_DOCS_URL = "https://docs.mcpjam.com/mcp";

function extractAssistantText(
  assistantMessages: Array<{ content: unknown }>
): string {
  const parts: string[] = [];
  for (const message of assistantMessages) {
    if (typeof message.content === "string") {
      if (message.content) parts.push(message.content);
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          parts.push((part as { text: string }).text);
        }
      }
    }
  }
  return parts.join("\n").trim();
}

const agent = new Hono();

agent.post("/projects/:projectId/agent", async (c) => {
  const projectId = c.req.param("projectId");

  // Graceful degradation on OSS/self-hosted installs: the hosted engine and
  // the delegated-token mint both require the backend wiring.
  if (!process.env.CONVEX_HTTP_URL || !process.env.INSPECTOR_SERVICE_TOKEN) {
    return v1Error(
      c,
      "FEATURE_NOT_SUPPORTED",
      "The agent endpoint requires a hosted MCPJam deployment."
    );
  }

  if (!isHostedCatalogModel(String(AGENT_API_MODEL.id), "anthropic")) {
    return v1Error(
      c,
      "FEATURE_NOT_SUPPORTED",
      "The agent endpoint's hosted model is unavailable on this deployment."
    );
  }

  const body = parseWithSchema(
    agentTurnSchema,
    await c.req.json().catch(() => {
      return {};
    })
  );

  const orgKey =
    c.get("mcpjamOrganizationId") ?? c.get("workosUserId") ?? "anonymous";
  if (!acquireTurnSlot(orgKey)) {
    return v1Error(
      c,
      "RATE_LIMITED",
      `Too many concurrent agent turns for this organization (max ${MAX_CONCURRENT_TURNS_PER_ORG}).`
    );
  }

  const startedAt = Date.now();
  let manager: MCPClientManager | undefined;
  const abortController = new AbortController();
  const wallClock = setTimeout(
    () => abortController.abort(),
    TURN_WALL_CLOCK_MS
  );

  try {
    // One delegated org-scoped JWT for both the engine's Convex calls and the
    // self-dispatched platform-op calls (see module docblock).
    const convexJwt = await getConvexBearerForRequest(c);
    const authHeader = `Bearer ${convexJwt}`;

    const selfFetch = getSelfFetch();
    if (!selfFetch) {
      return v1Error(
        c,
        "INTERNAL_ERROR",
        "In-process /api/v1 dispatch is not registered."
      );
    }
    const client = new PlatformApiClient({
      baseUrl: "http://self.mcpjam.internal/api/v1",
      getAuth: () => convexJwt,
      fetch: async (input, init) => selfFetch(new Request(input, init)),
    });

    const created: CreatedResource[] = [];
    const builtInTools = buildAgentApiToolSet({ client, projectId, created });

    // Docs server with preflight-degrade: `getToolsForAiSdk` (inside
    // `prepareChatV2`) fails the whole turn when a selected server errors at
    // connect/list time, so a docs outage must deselect it, not 500 the turn.
    manager = new MCPClientManager(
      {
        [DOCS_SERVER_ID]: {
          url: process.env.MCPJAM_DOCS_MCP_URL ?? DEFAULT_DOCS_URL,
          timeout: 30_000,
        },
      },
      {
        defaultTimeout: WEB_STREAM_TIMEOUT_MS,
        retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
      }
    );
    const [docsPreflight] = await Promise.allSettled([
      manager.listTools(DOCS_SERVER_ID),
    ]);
    const selectedServers =
      docsPreflight?.status === "fulfilled" ? [DOCS_SERVER_ID] : [];
    if (docsPreflight?.status === "rejected") {
      logger.warn("[v1/agent] docs MCP server unavailable; continuing", {
        error:
          docsPreflight.reason instanceof Error
            ? docsPreflight.reason.message
            : String(docsPreflight.reason),
      });
    }

    const prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers,
      modelDefinition: AGENT_API_MODEL,
      systemPrompt: AGENT_API_SYSTEM_PROMPT,
      builtInTools,
      skillsSource: { kind: "none" },
    });

    const chatSessionId = randomUUID();
    const rt = await resolveTurnRuntime({
      modelDefinition: AGENT_API_MODEL,
      projectId,
      authHeader,
      sourceType: "direct",
      chatSessionId,
      tools: prepared.allTools,
    });
    if (rt.runtime.kind !== "hosted") {
      // Unreachable for a pinned hosted-catalog model; guard so a resolver
      // change can't silently route this endpoint onto a BYOK rail.
      return v1Error(
        c,
        "INTERNAL_ERROR",
        "Agent turn resolved to an unexpected runtime."
      );
    }

    let lastEngineError:
      | { message: string; code?: string; httpStatus?: number }
      | undefined;

    const result = await runUnifiedAssistantTurn({
      runtime: rt.runtime,
      streamSink: "none",
      persistMode: "caller",
      approvalMode: "auto-deny",
      messages: body.messages,
      modelDefinition: AGENT_API_MODEL,
      systemPrompt: prepared.enhancedSystemPrompt,
      tools: prepared.allTools,
      mcpClientManager: manager,
      authContext: { kind: "user_bearer", token: authHeader },
      sourceType: "direct",
      origin: "mcpjam_agent",
      maxSteps: MAX_STEPS,
      projectId,
      chatSessionId,
      abortSignal: abortController.signal,
      ...(prepared.progressivePlan
        ? { progressivePlan: prepared.progressivePlan }
        : {}),
      ...(prepared.discoveryState
        ? { discoveryState: prepared.discoveryState }
        : {}),
      onEngineError: (event: {
        message: string;
        code?: string;
        httpStatus?: number;
      }) => {
        lastEngineError = event;
      },
    });

    if (abortController.signal.aborted) {
      captureTurnEvent(c, {
        startedAt,
        outcome: "timeout",
        toolCallCount: result.toolCalls.length,
      });
      return v1Error(
        c,
        "TIMEOUT",
        `Agent turn exceeded the ${TURN_WALL_CLOCK_MS / 1000}s limit.`
      );
    }

    // Hosted-engine failure contract: a missing turnTrace on a non-aborted
    // turn means the engine failed; the structured cap/quota detail only
    // arrives via onEngineError in streamSink:"none" mode.
    if (!result.turnTrace) {
      const message =
        lastEngineError?.message ??
        "Agent turn failed: the engine returned no turn trace.";
      const rateLimited =
        lastEngineError?.httpStatus === 429 ||
        rt.classifyFailure(message) === "rate_limited";
      captureTurnEvent(c, {
        startedAt,
        outcome: rateLimited ? "rate_limited" : "failed",
        toolCallCount: result.toolCalls.length,
      });
      return v1Error(
        c,
        rateLimited ? "RATE_LIMITED" : "INTERNAL_ERROR",
        message
      );
    }

    const reply = extractAssistantText(result.assistantMessages);
    captureTurnEvent(c, {
      startedAt,
      outcome: "ok",
      toolCallCount: result.toolCalls.length,
      opNames: result.toolCalls.map((call) => call.toolName),
      createdCount: created.length,
    });

    return v1Resource(c, {
      reply,
      toolCalls: result.toolCalls.map((call) => ({
        operation: call.toolName,
      })),
      createdResources: created,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      },
    });
  } finally {
    clearTimeout(wallClock);
    releaseTurnSlot(orgKey);
    if (manager) {
      void manager.disconnectAllServers().catch(() => undefined);
    }
  }
});

/**
 * Server-authoritative telemetry (`agent_turn_completed` is client-only —
 * this surface has no client). Names, booleans, counts, durations ONLY:
 * tool args/outputs here are customer conversation content.
 */
function captureTurnEvent(
  c: Parameters<typeof captureServerEvent>[0],
  data: {
    startedAt: number;
    outcome: "ok" | "failed" | "rate_limited" | "timeout";
    toolCallCount: number;
    opNames?: string[];
    createdCount?: number;
  }
): void {
  // API-key callers never pass the Convex authorize exchange that normally
  // fills `userExternalId`; the WorkOS user id from bearer auth IS the
  // actorKey the analytics identity contract requires.
  const ctx = c.var.requestLogContext as RequestLogContext | undefined;
  const workosUserId = c.get("workosUserId");
  if (ctx && !ctx.userExternalId && workosUserId) {
    c.set("requestLogContext", { ...ctx, userExternalId: workosUserId });
  }
  captureServerEvent(c, "api_agent_turn_completed", {
    surface: "api",
    outcome: data.outcome,
    duration_ms: Date.now() - data.startedAt,
    tool_call_count: data.toolCallCount,
    ...(data.opNames ? { op_names: data.opNames } : {}),
    ...(data.createdCount !== undefined
      ? { created_count: data.createdCount }
      : {}),
  });
}

export default agent;
