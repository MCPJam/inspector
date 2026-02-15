import { ModelDefinition } from "@/shared/types";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  isChatGPTAppTool,
  isMcpAppTool,
  scrubMetaFromToolResult,
  scrubMetaAndStructuredContentFromToolResult,
  type MCPClientManager,
} from "@mcpjam/sdk";

export interface BaseUrls {
  ollama?: string;
  azure?: string;
}

export interface CustomProviderConfig {
  name: string;
  protocol: string;
  baseUrl: string;
  modelIds: string[];
  apiKey?: string;
}

export const createLlmModel = (
  modelDefinition: ModelDefinition,
  apiKey: string,
  baseUrls?: BaseUrls,
  customProviders?: CustomProviderConfig[],
) => {
  if (!modelDefinition?.id || !modelDefinition?.provider) {
    throw new Error(
      `Invalid model definition: ${JSON.stringify(modelDefinition)}`,
    );
  }
  switch (modelDefinition.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(modelDefinition.id);
    case "openai":
      return createOpenAI({ apiKey })(modelDefinition.id);
    case "deepseek":
      return createDeepSeek({ apiKey })(modelDefinition.id);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(modelDefinition.id);
    case "ollama": {
      const raw = baseUrls?.ollama || "http://127.0.0.1:11434/api";
      const normalized = /\/api\/?$/.test(raw)
        ? raw
        : `${raw.replace(/\/+$/, "")}/api`;
      return createOllama({ baseURL: normalized })(modelDefinition.id);
    }
    case "mistral":
      return createMistral({ apiKey })(modelDefinition.id);
    case "openrouter":
      return createOpenRouter({
        apiKey,
        headers: {
          "HTTP-Referer": "https://www.mcpjam.com/",
          "X-Title": "MCPJam",
        },
      })(modelDefinition.id);
    case "xai":
      return createXai({ apiKey })(modelDefinition.id);
    case "azure":
      return createAzure({ apiKey, baseURL: baseUrls?.azure })(
        modelDefinition.id,
      );
    case "custom": {
      const providerName = modelDefinition.customProviderName;
      if (!providerName) {
        throw new Error(
          `Custom provider model missing customProviderName: ${modelDefinition.id}`,
        );
      }
      const cp = customProviders?.find((p) => p.name === providerName);
      if (!cp) {
        throw new Error(`Custom provider not found: ${providerName}`);
      }
      // Strip the "custom:<providerName>:" namespace prefix to get the raw model ID
      // Client sends id as "custom:<providerName>:<modelId>" to avoid clashes with built-in models
      const rawModelId = String(modelDefinition.id).startsWith("custom:")
        ? String(modelDefinition.id).split(":").slice(2).join(":")
        : String(modelDefinition.id);
      // Use the custom provider's apiKey, falling back to the runtime apiKey
      const resolvedApiKey = cp.apiKey || apiKey || "";
      if (cp.protocol === "anthropic-compatible") {
        return createAnthropic({
          apiKey: resolvedApiKey,
          baseURL: cp.baseUrl,
        })(rawModelId);
      }
      // Default: openai-compatible
      // Always use .chat() (Chat Completions API) since virtually all
      // OpenAI-compatible providers implement /chat/completions
      return createOpenAI({
        apiKey: resolvedApiKey,
        baseURL: cp.baseUrl,
      }).chat(rawModelId);
    }
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
};

const ANTHROPIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const isAnthropicCompatibleModel = (
  modelDefinition: ModelDefinition,
  customProviders?: CustomProviderConfig[],
): boolean => {
  if (modelDefinition.provider === "anthropic") {
    return true;
  }
  if (modelDefinition.provider === "custom") {
    const providerName = modelDefinition.customProviderName;
    if (!providerName) return false;
    const cp = customProviders?.find((p) => p.name === providerName);
    return cp?.protocol === "anthropic-compatible";
  }
  return false;
};

export const getInvalidAnthropicToolNames = (toolNames: string[]): string[] => {
  return toolNames.filter((name) => !ANTHROPIC_TOOL_NAME_PATTERN.test(name));
};

export const scrubMcpAppsToolResultsForBackend = (
  messages: ModelMessage[],
  mcpClientManager: MCPClientManager,
  selectedServers?: string[] | string,
): ModelMessage[] => {
  const serverIds = Array.isArray(selectedServers)
    ? selectedServers
    : selectedServers
      ? [selectedServers]
      : mcpClientManager.listServers();
  const metaByServer = new Map<string, Record<string, any>>();
  for (const serverId of serverIds) {
    metaByServer.set(serverId, mcpClientManager.getAllToolsMetadata(serverId));
  }
  const shouldScrub = (toolName?: string, serverId?: string): boolean => {
    if (!toolName) return false;
    if (serverId) {
      return isMcpAppTool(metaByServer.get(serverId)?.[toolName]);
    }
    for (const metaMap of metaByServer.values()) {
      if (isMcpAppTool(metaMap?.[toolName])) return true;
    }
    return false;
  };

  return messages.map((msg) => {
    if (!msg || msg.role !== "tool" || !Array.isArray((msg as any).content)) {
      return msg;
    }
    const content = (msg as any).content.map((part: any) => {
      if (part?.type !== "tool-result") return part;
      const toolName = part.toolName ?? part.name;
      if (!shouldScrub(toolName, part.serverId)) return part;
      const nextPart = { ...part };
      if (nextPart.output?.type === "json") {
        nextPart.output = {
          ...nextPart.output,
          value: scrubMetaAndStructuredContentFromToolResult(
            nextPart.output.value,
          ),
        };
      }
      if ("result" in nextPart) {
        nextPart.result = scrubMetaAndStructuredContentFromToolResult(
          nextPart.result,
        );
      }
      return nextPart;
    });
    return { ...msg, content } as ModelMessage;
  });
};

export const scrubChatGPTAppsToolResultsForBackend = (
  messages: ModelMessage[],
  mcpClientManager: MCPClientManager,
  selectedServers?: string[] | string,
): ModelMessage[] => {
  const serverIds = Array.isArray(selectedServers)
    ? selectedServers
    : selectedServers
      ? [selectedServers]
      : mcpClientManager.listServers();
  const metaByServer = new Map<string, Record<string, any>>();
  for (const serverId of serverIds) {
    metaByServer.set(serverId, mcpClientManager.getAllToolsMetadata(serverId));
  }
  const shouldScrub = (toolName?: string, serverId?: string): boolean => {
    if (!toolName) return false;
    if (serverId) {
      return isChatGPTAppTool(metaByServer.get(serverId)?.[toolName]);
    }
    for (const metaMap of metaByServer.values()) {
      if (isChatGPTAppTool(metaMap?.[toolName])) return true;
    }
    return false;
  };

  const scrubPayload = (payload: unknown): unknown => {
    if (!payload || typeof payload !== "object") return payload;
    const withoutMeta = scrubMetaFromToolResult(payload as any);
    if (!("structuredContent" in (withoutMeta as Record<string, unknown>))) {
      return withoutMeta;
    }
    const { structuredContent: _removed, ...rest } = withoutMeta as Record<
      string,
      unknown
    >;
    return rest;
  };

  return messages.map((msg) => {
    if (!msg || msg.role !== "tool" || !Array.isArray((msg as any).content)) {
      return msg;
    }
    const content = (msg as any).content.map((part: any) => {
      if (part?.type !== "tool-result") return part;
      const toolName = part.toolName ?? part.name;
      if (!shouldScrub(toolName, part.serverId)) return part;
      const nextPart = { ...part };
      if (nextPart.output?.type === "json") {
        nextPart.output = {
          ...nextPart.output,
          value: scrubPayload(nextPart.output.value),
        };
      }
      if ("result" in nextPart) {
        nextPart.result = scrubPayload(nextPart.result);
      }
      return nextPart;
    });
    return { ...msg, content } as ModelMessage;
  });
};
