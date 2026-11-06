/**
 * What one event run depends on (C6), and the defaults the executor uses
 * when a dependency is not injected: the owner's delegated bearer, the
 * environment's servers, the authorized connection, the model, the runtime
 * and the turn itself. Heavy modules load on first use.
 */

import type { ModelMessage, ToolSet } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type {
  PrepareChatV2Options,
  PrepareChatV2Result,
} from "../../utils/chat-v2-orchestration.js";
import type { SyntheticModelSource } from "../../utils/org-model-config.js";
import type {
  RunUnifiedAssistantTurnOptions,
  TurnRuntime,
  UnifiedTurnResult,
} from "../../utils/turn-execution.js";
import type { EventRunClaim, EventRunInput, EventsBackendClient } from "./backend-client.js";
import type { TranscriptPort } from "./run-transcript.js";
import { shortError } from "./run-turn.js";

/**
 * Model for a trigger that names none and whose environment names none: the
 * hosted default evals use for generated suites (`DEFAULT_SUITE_MODEL` in
 * `routes/v1/agent.ts`), billed to the owner's organization like any turn.
 */
export const DEFAULT_EVENT_RUN_MODEL_ID = "anthropic/claude-haiku-4.5";

/** What the executor reads from a finished turn. */
export type EventTurnResult = Pick<
  UnifiedTurnResult,
  "messages" | "newMessages" | "toolCalls" | "toolResults" | "turnTrace" | "aborted"
>;

/** What the executor reads from a prepared chat. */
export type EventPreparedChat = Pick<PrepareChatV2Result, "allTools" | "enhancedSystemPrompt"> &
  Partial<Pick<PrepareChatV2Result, "progressivePlan" | "discoveryState">>;

export interface EventRunConnection {
  manager: MCPClientManager;
  close(): Promise<void>;
}

export interface EventExecutorDeps {
  backend: Pick<
    EventsBackendClient,
    "claimRun" | "checkpointRun" | "beginCall" | "finishCall" | "finishRun"
  >;
  getBearer?: (ownerExternalId: string, organizationId: string) => Promise<string>;
  /** Which servers the run connects (C6). Default: environment → subscription. */
  resolveServers?: (args: {
    claim: EventRunClaim;
    input: EventRunInput;
    bearer: string;
  }) => Promise<{ serverIds: string[]; serverNames?: string[]; environmentModelId?: string }>;
  connect?: (args: {
    projectId: string;
    bearer: string;
    serverIds: string[];
    serverNames?: string[];
    /** The subscription's pinned OAuth connection, by server id. */
    connectionIds?: Record<string, string>;
  }) => Promise<EventRunConnection>;
  resolveModel?: (args: {
    modelId: string;
    projectId: string;
    bearer: string;
  }) => Promise<ModelDefinition>;
  /**
   * Default: `resolveTurnRuntime` with `sourceType: "event"`, attributing the
   * turn's model usage to `runId` (the backend charges the trigger's spend
   * cap from those usage records).
   */
  resolveRuntime?: (args: {
    modelDefinition: ModelDefinition;
    projectId: string;
    authHeader: string;
    runId: string;
    chatSessionId: string;
    tools: ToolSet;
    messages: ModelMessage[];
  }) => Promise<{ runtime: TurnRuntime; modelSource?: SyntheticModelSource }>;
  /**
   * Where each run's turn is appended (one chat thread per trigger). `false`
   * disables it. Default: `/ingest-chat` via `persistChatSessionToConvex`.
   */
  transcript?: TranscriptPort | false;
  runTurn?: (options: RunUnifiedAssistantTurnOptions) => Promise<EventTurnResult>;
  prepareChat?: (options: PrepareChatV2Options) => Promise<EventPreparedChat>;
}

export async function defaultResolveServers(args: {
  claim: EventRunClaim;
  input: EventRunInput;
  bearer: string;
}): Promise<{ serverIds: string[]; serverNames?: string[]; environmentModelId?: string }> {
  const environmentId =
    args.input.trigger.environmentId ?? args.input.subscription.environmentId ?? null;
  if (!environmentId) return { serverIds: [args.input.subscription.serverId] };
  const [
    { createConvexClient },
    {
      EVAL_LAUNCH_SERVER_SOURCE,
      environmentServerIds,
      environmentServerNames,
      resolveEnvironmentForLaunch,
    },
  ] = await Promise.all([
    import("../evals/route-helpers.js"),
    import("../environments/resolve.js"),
  ]);
  // The environment's closed server set and nothing else — the same rule an
  // eval launch applies, for the same reason: the run must be what the
  // environment says it is.
  const resolved = await resolveEnvironmentForLaunch(createConvexClient(args.bearer), {
    projectId: String(args.claim.run.projectId),
    environmentId,
    serverSource: EVAL_LAUNCH_SERVER_SOURCE,
  });
  return {
    serverIds: environmentServerIds(resolved),
    serverNames: environmentServerNames(resolved),
    ...(resolved.effectiveModelId ? { environmentModelId: resolved.effectiveModelId } : {}),
  };
}

export async function defaultConnect(args: {
  projectId: string;
  bearer: string;
  serverIds: string[];
  serverNames?: string[];
  connectionIds?: Record<string, string>;
}): Promise<EventRunConnection> {
  const { createAuthorizedManager } = await import("../../routes/web/auth.js");
  const options = {
    ...(args.serverNames && args.serverNames.length > 0
      ? { serverNames: args.serverNames }
      : {}),
    ...(args.connectionIds ? { connectionIds: args.connectionIds } : {}),
  };
  const { manager } = await createAuthorizedManager(
    {},
    args.bearer,
    args.projectId,
    args.serverIds,
    WEB_CALL_TIMEOUT_MS,
    undefined,
    undefined,
    Object.keys(options).length > 0 ? options : undefined,
  );
  return {
    manager,
    close: async () => {
      try {
        await manager.disconnectAllServers();
      } catch (error) {
        // The run is already settled; a transport that will not close
        // cleanly changes nothing about it.
        logger.debug("[events-executor] disconnect failed", { error: shortError(error) });
      }
    },
  };
}

export async function defaultResolveModel(args: {
  modelId: string;
  projectId: string;
  bearer: string;
}): Promise<ModelDefinition> {
  const { resolveHostModelDefinition } = await import("../../utils/org-model-config.js");
  return resolveHostModelDefinition({
    modelId: args.modelId,
    projectId: args.projectId,
    auth: { bearerToken: args.bearer },
  });
}

export async function defaultResolveRuntime(args: {
  modelDefinition: ModelDefinition;
  projectId: string;
  authHeader: string;
  runId: string;
  chatSessionId: string;
  tools: ToolSet;
  messages: ModelMessage[];
}) {
  const { resolveTurnRuntime } = await import("../../utils/resolve-turn-runtime.js");
  return resolveTurnRuntime({
    modelDefinition: args.modelDefinition,
    projectId: args.projectId,
    authHeader: args.authHeader,
    sourceType: "event",
    // Every billed model call names the run, on the hosted `/stream` body and
    // on the local-runtime usage writeback alike: the backend charges the
    // trigger's daily spend cap from those usage records (C6).
    extraBodyFields: { eventRunId: args.runId },
    attribution: { eventRunId: args.runId },
    chatSessionId: args.chatSessionId,
    tools: args.tools,
    messages: args.messages,
  });
}

export async function defaultGetBearer(ownerExternalId: string, organizationId: string) {
  const { getConvexBearerForDelegation } = await import("../../utils/v1-convex-token.js");
  return getConvexBearerForDelegation(ownerExternalId, organizationId);
}

export async function defaultPrepareChat(
  options: PrepareChatV2Options,
): Promise<EventPreparedChat> {
  return (await import("../../utils/chat-v2-orchestration.js")).prepareChatV2(options);
}

export async function defaultRunTurn(
  options: RunUnifiedAssistantTurnOptions,
): Promise<EventTurnResult> {
  return (await import("../../utils/turn-execution.js")).runUnifiedAssistantTurn(options);
}
