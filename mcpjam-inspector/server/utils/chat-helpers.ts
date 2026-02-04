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
  litellm?: string;
  azure?: string;
  anthropic?: string;
  openai?: string;
}

export const createLlmModel = (
  modelDefinition: ModelDefinition,
  apiKey: string,
  baseUrls?: BaseUrls,
) => {
  if (!modelDefinition?.id || !modelDefinition?.provider) {
    throw new Error(
      `Invalid model definition: ${JSON.stringify(modelDefinition)}`,
    );
  }
  switch (modelDefinition.provider) {
    case "anthropic":
      return createAnthropic({
        apiKey,
        ...(baseUrls?.anthropic && { baseURL: baseUrls.anthropic }),
      })(modelDefinition.id);
    case "openai":
      return createOpenAI({
        apiKey,
        ...(baseUrls?.openai && { baseURL: baseUrls.openai }),
      })(modelDefinition.id);
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
    case "litellm": {
      // LiteLLM uses OpenAI-compatible endpoints (standard chat completions API)
      const baseURL = baseUrls?.litellm || "http://localhost:4000";
      // LiteLLM may not require API key depending on setup - use env var or empty string
      const litellmApiKey = apiKey || process.env.LITELLM_API_KEY || "";
      const openai = createOpenAI({
        apiKey: litellmApiKey,
        baseURL,
      });
      // IMPORTANT: Use .chat() to use Chat Completions API instead of Responses API
      return openai.chat(modelDefinition.id);
    }
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
    default:
      throw new Error(
        `Unsupported provider: ${modelDefinition.provider} for model: ${modelDefinition.id}`,
      );
  }
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
