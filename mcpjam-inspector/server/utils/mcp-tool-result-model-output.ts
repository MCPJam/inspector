import { convertToModelMessages } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  type McpLinkedResourceReader,
  type McpModelVisibleToolResultPolicy,
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
} from "@mcpjam/sdk";
import {
  readMcpToolOriginServerId,
  stripMcpToolOriginMetadata,
} from "@/shared/mcp-tool-origin-metadata";

export type McpToolResultModelOutputOptions =
  McpModelVisibleToolResultPolicy & {
    readLinkedResource?: (params: {
      serverId: string;
      uri: string;
      options?: { abortSignal?: AbortSignal };
    }) => Promise<unknown>;
    resolveLinkedResourceServerId?: (params: {
      toolCallId?: string;
      toolName?: string;
    }) => string | undefined | Promise<string | undefined>;
    abortSignal?: AbortSignal;
  };

function canReplaySourcelessImageMedia(
  options: McpModelVisibleToolResultPolicy
): boolean {
  const policy = options.modelVisibleMcpToolResults;
  const directImages = policy?.directContent?.image ?? true;
  const embeddedImages =
    (policy?.embeddedResources?.blob?.enabled ?? true) &&
    (policy?.embeddedResources?.blob?.image ?? true);
  const linkedImages =
    (policy?.linkedResources?.blob?.enabled ?? true) &&
    (policy?.linkedResources?.blob?.image ?? true);

  return directImages && embeddedImages && linkedImages;
}

function linkedResourceReaderForPart(
  part: unknown,
  fallbackServerId: string | undefined,
  options: McpToolResultModelOutputOptions
): McpLinkedResourceReader | undefined {
  const serverId = readServerIdFromToolResultPart(part) ?? fallbackServerId;
  if (typeof serverId !== "string" || !options.readLinkedResource) {
    return undefined;
  }

  return ({ uri, options: readOptions }) =>
    options.readLinkedResource!({
      serverId,
      uri,
      options: readOptions,
    });
}

function readServerIdFromToolResultPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const record = part as Record<string, unknown>;
  const legacy = record.serverId;
  if (typeof legacy === "string" && legacy.length > 0) {
    return legacy;
  }
  return readMcpToolOriginServerId(record.providerOptions);
}

function readToolCallId(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === "string" && toolCallId.length > 0
    ? toolCallId
    : undefined;
}

function readToolName(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const toolName = (part as { toolName?: unknown }).toolName;
  return typeof toolName === "string" && toolName.length > 0
    ? toolName
    : undefined;
}

function readPartType(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const type = (part as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function unwrapJsonToolOutput(output: unknown): unknown {
  let current = output;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const record = current as Record<string, unknown>;
    if (
      record.type !== "json" ||
      !Object.prototype.hasOwnProperty.call(record, "value")
    ) {
      return current;
    }
    current = record.value;
  }
  return current;
}

function readRawMcpResultFromPart(part: unknown): unknown | undefined {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return undefined;
  }
  const result = (part as { result?: unknown }).result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result
    : undefined;
}

function hasImageResourceLinkCandidate(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const content = (result as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        !!block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === "resource_link" &&
        typeof (block as { mimeType?: unknown }).mimeType === "string" &&
        (block as { mimeType: string }).mimeType.startsWith("image/")
    )
  );
}

function isImageOmissionMarkerText(text: string): boolean {
  return (
    text.startsWith("[image omitted:") ||
    text.startsWith("[resource link omitted:") ||
    text.startsWith("[audio omitted:") ||
    text.startsWith("[embedded resource omitted") ||
    text.startsWith("[unsupported MCP content omitted:")
  );
}

function readReplayableImageModelOutput(
  output: unknown,
  options: { allowMedia: boolean }
): unknown | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }

  const record = output as Record<string, unknown>;
  if (record.type !== "content" || !Array.isArray(record.value)) {
    return undefined;
  }

  let sawImageCandidate = false;
  let sawOmissionMarker = false;
  const value: unknown[] = [];

  for (const part of record.value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return undefined;
    }
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type === "text") {
      if (typeof partRecord.text !== "string") return undefined;
      if (isImageOmissionMarkerText(partRecord.text)) {
        sawOmissionMarker = true;
      }
      value.push({ type: "text", text: partRecord.text });
      continue;
    }

    if (partRecord.type === "media" || partRecord.type === "image-data") {
      if (
        typeof partRecord.data !== "string" ||
        typeof partRecord.mediaType !== "string" ||
        !partRecord.mediaType.startsWith("image/")
      ) {
        return undefined;
      }
      sawImageCandidate = true;
      if (!options.allowMedia) {
        value.push({
          type: "text",
          text: "[image omitted: replayed image policy disabled]",
        });
        continue;
      }
      const validated = mcpCallToolResultToModelOutput({
        content: [
          {
            type: "image",
            data: partRecord.data,
            mimeType: partRecord.mediaType,
          },
        ],
      } as never);
      const validatedPart = validated?.value[0];
      if (!validatedPart) return undefined;
      value.push(validatedPart);
      continue;
    }

    return undefined;
  }

  if (!sawImageCandidate && !sawOmissionMarker) {
    return undefined;
  }

  return { type: "content", value };
}

export function createLinkedResourceServerIdResolver(args: {
  serverIds: readonly string[];
  listTools: (serverId: string) => Promise<{
    tools?: Array<{ name?: unknown }>;
  }>;
}): NonNullable<
  McpToolResultModelOutputOptions["resolveLinkedResourceServerId"]
> {
  const cache = new Map<string, Promise<string | undefined>>();
  return ({ toolName }) => {
    if (!toolName) return undefined;
    let cached = cache.get(toolName);
    if (!cached) {
      cached = (async () => {
        const matches: string[] = [];
        for (const serverId of args.serverIds) {
          try {
            const result = await args.listTools(serverId);
            if (
              Array.isArray(result.tools) &&
              result.tools.some((tool) => tool.name === toolName)
            ) {
              matches.push(serverId);
            }
          } catch {
            // Best-effort fallback only. Metadata-bearing results never use this.
          }
        }
        return matches.length === 1 ? matches[0] : undefined;
      })();
      cache.set(toolName, cached);
    }
    return cached;
  };
}

function stripInternalProviderOptions(part: unknown): unknown {
  if (!part || typeof part !== "object" || Array.isArray(part)) return part;
  const record = part as Record<string, unknown>;
  if (!record.providerOptions) return part;
  const providerOptions = stripMcpToolOriginMetadata(record.providerOptions);
  const { providerOptions: _providerOptions, ...rest } = record;
  return providerOptions ? { ...rest, providerOptions } : rest;
}

export async function mapMcpImageToolOutputs(
  messages: ModelMessage[],
  options: McpToolResultModelOutputOptions = {}
): Promise<ModelMessage[]> {
  const mappedMessages: ModelMessage[] = [];
  const serverIdByToolCallId = new Map<string, string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      mappedMessages.push(message);
      continue;
    }

    let didChange = false;
    const content: unknown[] = [];

    for (const part of message.content) {
      const toolCallId = readToolCallId(part);
      if (toolCallId && readPartType(part) === "tool-call") {
        const serverId = readServerIdFromToolResultPart(part);
        if (serverId) {
          serverIdByToolCallId.set(toolCallId, serverId);
        }
      }

      if (message.role !== "tool") {
        const stripped = stripInternalProviderOptions(part);
        if (stripped !== part) didChange = true;
        content.push(stripped);
        continue;
      }

      const rawResultValue = readRawMcpResultFromPart(part);
      if (
        part.type !== "tool-result" ||
        (!rawResultValue && part.output?.type !== "json")
      ) {
        const stripped = stripInternalProviderOptions(part);
        if (stripped !== part) didChange = true;
        content.push(stripped);
        continue;
      }

      const rawOutputValue =
        rawResultValue ?? unwrapJsonToolOutput(part.output);
      const strippedPart = stripInternalProviderOptions(part);
      if (rawOutputValue == null || typeof rawOutputValue !== "object") {
        if (strippedPart !== part) didChange = true;
        content.push(strippedPart);
        continue;
      }

      const replayedModelOutput = readReplayableImageModelOutput(
        rawOutputValue,
        { allowMedia: canReplaySourcelessImageMedia(options) }
      );
      if (replayedModelOutput) {
        didChange = true;
        content.push({
          ...(strippedPart as Record<string, unknown>),
          output: replayedModelOutput,
        });
        continue;
      }

      const toolName = readToolName(part);
      const metadataServerId = toolCallId
        ? serverIdByToolCallId.get(toolCallId)
        : undefined;
      const resolvedServerId =
        metadataServerId ??
        (hasImageResourceLinkCandidate(rawOutputValue)
          ? await options.resolveLinkedResourceServerId?.({
              toolCallId,
              toolName,
            })
          : undefined);
      const readResource = linkedResourceReaderForPart(
        part,
        resolvedServerId,
        options
      );
      const modelOutput = readResource
        ? await mcpCallToolResultToModelOutputWithLinkedResources(
            rawOutputValue as any,
            {
              modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
              readResource,
              abortSignal: options.abortSignal,
            }
          )
        : mcpCallToolResultToModelOutput(rawOutputValue as any, {
            modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
          });
      if (!modelOutput) {
        if (strippedPart !== part) didChange = true;
        content.push(strippedPart);
        continue;
      }

      didChange = true;
      content.push({
        ...(strippedPart as Record<string, unknown>),
        output: modelOutput,
      });
    }

    mappedMessages.push(
      didChange ? ({ ...message, content } as ModelMessage) : message
    );
  }

  return mappedMessages;
}

export async function convertToMcpjamModelMessages(
  messages: Parameters<typeof convertToModelMessages>[0],
  options: McpToolResultModelOutputOptions = {}
): Promise<ModelMessage[]> {
  return mapMcpImageToolOutputs(
    (await convertToModelMessages(messages)) as ModelMessage[],
    options
  );
}
