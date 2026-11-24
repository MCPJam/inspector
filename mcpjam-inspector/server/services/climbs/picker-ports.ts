/**
 * What one picker step depends on, in one place so a test can stand in for each
 * part: the connection to the real server, the model, the runtime, the prepared
 * tools, the turn itself and the transcript's store. The defaults load their
 * heavy modules on first use, as the event executor's do.
 */
import type { ModelMessage, ToolSet } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { PrepareChatV2Options, PrepareChatV2Result } from "../../utils/chat-v2-orchestration.js";
import type { PersistChatOutcome } from "../../utils/chat-ingestion.js";
import type { SyntheticModelSource } from "../../utils/org-model-config.js";
import type { RunUnifiedAssistantTurnOptions, TurnRuntime, UnifiedTurnResult } from "../../utils/turn-execution.js";

export type PickerConnection = {
  manager: MCPClientManager;
  /** The names of the real server's tools that are not marked read-only: the turn never sees them. */
  writeTools: string[];
  close(): Promise<void>;
};

export type PickerTurnResult = Pick<UnifiedTurnResult, "messages" | "newMessages" | "toolCalls" | "toolResults" | "turnTrace" | "usage" | "aborted">;
export type PickerPrepared = Pick<PrepareChatV2Result, "allTools" | "enhancedSystemPrompt"> &
  Partial<Pick<PrepareChatV2Result, "progressivePlan" | "discoveryState">>;

export type PickerPorts = {
  connect(args: { projectId: string; bearer: string; serverId: string }): Promise<PickerConnection>;
  resolveModel(args: { modelId: string; projectId: string; bearer: string }): Promise<ModelDefinition>;
  resolveRuntime(args: {
    modelDefinition: ModelDefinition;
    projectId: string;
    authHeader: string;
    chatSessionId: string;
    tools: ToolSet;
    messages: ModelMessage[];
  }): Promise<{ runtime: TurnRuntime; modelSource?: SyntheticModelSource }>;
  prepareChat(options: PrepareChatV2Options): Promise<PickerPrepared>;
  runTurn(options: RunUnifiedAssistantTurnOptions): Promise<PickerTurnResult>;
  persist(options: Parameters<typeof import("../../utils/chat-ingestion.js").persistChatSessionToConvex>[0]): Promise<PersistChatOutcome>;
};

export const defaultPickerPorts: PickerPorts = {
  async connect({ projectId, bearer, serverId }) {
    const [{ createAuthorizedManager }, { listAllTools }] = await Promise.all([
      import("../../routes/web/auth.js"),
      import("@mcpjam/sdk/operations"),
    ]);
    const { manager } = await createAuthorizedManager({}, bearer, projectId, [serverId], WEB_CALL_TIMEOUT_MS);
    const { tools } = await listAllTools(manager, { serverId, cacheMode: "bypass" });
    // The filter `send_chat_message` applies by default: a tool that does not say it only reads is left out.
    const writeTools = tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
    return {
      manager,
      writeTools,
      close: async () => {
        try {
          await manager.disconnectAllServers();
        } catch (error) {
          // The step has already ended; a transport that will not close changes nothing about it.
          logger.debug("[climbs] a picker step's server connection did not close cleanly", { error: error instanceof Error ? error.message : String(error) });
        }
      },
    };
  },
  async resolveModel({ modelId, projectId, bearer }) {
    const { resolveHostModelDefinition } = await import("../../utils/org-model-config.js");
    return resolveHostModelDefinition({ modelId, projectId, auth: { bearerToken: bearer } });
  },
  async resolveRuntime(args) {
    const { resolveTurnRuntime } = await import("../../utils/resolve-turn-runtime.js");
    return resolveTurnRuntime({ ...args, sourceType: "direct" });
  },
  async prepareChat(options) {
    return (await import("../../utils/chat-v2-orchestration.js")).prepareChatV2(options);
  },
  async runTurn(options) {
    return (await import("../../utils/turn-execution.js")).runUnifiedAssistantTurn(options);
  },
  async persist(options) {
    return (await import("../../utils/chat-ingestion.js")).persistChatSessionToConvex(options);
  },
};
