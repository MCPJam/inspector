import { isUIResource } from "@mcp-ui/client";
import type { DynamicToolUIPart, ModelMessage, UIMessage } from "ai";
import { buildPersistedExecutionReplay } from "@/components/chat-v2/thread/persisted-execution-replay";
import { extractTextFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { getToolServerId, type ToolServerMap } from "@/lib/apis/mcp-tools-api";
import {
  detectUIType,
  getUIResourceUri,
  UIType,
} from "@/lib/mcp-ui/mcp-apps-utils";
import {
  readToolResultMeta,
  readToolResultServerId,
} from "@/lib/tool-result-utils";
import type { EvalTraceSpan } from "@/shared/eval-trace";

export interface TraceContentPart {
  type: string;
  text?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  result?: unknown;
  error?: unknown;
  toolCallId?: string;
  toolName?: string;
  name?: string;
  parameters?: Record<string, unknown>;
  args?: Record<string, unknown>;
  isError?: boolean;
  serverId?: string;
  [key: string]: unknown;
}

export interface TraceMessage {
  role: string;
  content?: string | TraceContentPart[];
}

export type TraceSourceMessage = TraceMessage | ModelMessage;

export interface TraceWidgetSnapshot {
  toolCallId: string;
  toolName: string;
  protocol: "mcp-apps" | "openai-apps";
  serverId: string;
  resourceUri?: string;
  toolMetadata: Record<string, unknown>;
  widgetCsp?: Record<string, unknown> | null;
  widgetPermissions?: Record<string, unknown> | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  widgetHtmlUrl?: string | null;
  toolOutput?: unknown;
}

/**
 * Convert raw SharedChatWidgetSnapshot records (from Convex) into the
 * TraceWidgetSnapshot shape used by the trace viewer adapter.
 */
export function snapshotsToTraceWidgetSnapshots(
  snapshots: Array<{
    toolCallId: string;
    toolName: string;
    serverId: string;
    uiType: "mcp-apps" | "openai-apps";
    resourceUri?: string;
    widgetCsp: Record<string, unknown> | null;
    widgetPermissions: Record<string, unknown> | null;
    widgetPermissive: boolean;
    prefersBorder: boolean;
    widgetHtmlUrl?: string | null;
    toolOutput?: unknown;
  }>,
): TraceWidgetSnapshot[] {
  return snapshots.map((snap) => {
    // Reconstruct toolMetadata so detectUIType returns the correct widget type.
    // Without this, PartSwitch won't enter the widget rendering path.
    const toolMetadata: Record<string, unknown> =
      snap.uiType === "mcp-apps" && snap.resourceUri
        ? { ui: { resourceUri: snap.resourceUri } }
        : snap.uiType === "openai-apps"
          ? { "openai/outputTemplate": "__cached__" }
          : {};

    return {
      toolCallId: snap.toolCallId,
      toolName: snap.toolName,
      protocol: snap.uiType,
      serverId: snap.serverId,
      resourceUri: snap.resourceUri,
      toolMetadata,
      widgetCsp: snap.widgetCsp,
      widgetPermissions: snap.widgetPermissions,
      widgetPermissive: snap.widgetPermissive,
      prefersBorder: snap.prefersBorder,
      widgetHtmlUrl: snap.widgetHtmlUrl,
      toolOutput: snap.toolOutput,
    };
  });
}

/**
 * Build toolRenderOverrides directly from TraceWidgetSnapshot[].
 * Used when loading a persisted session where we have snapshots
 * but don't need the full adaptTraceToUiMessages pipeline.
 */
export function buildToolRenderOverridesFromSnapshots(
  snapshots: TraceWidgetSnapshot[],
): Record<string, ToolRenderOverride> {
  const overrides: Record<string, ToolRenderOverride> = {};
  for (const snap of snapshots) {
    const replay = buildPersistedExecutionReplay({
      protocol: snap.protocol,
      toolCallId: snap.toolCallId,
      toolName: snap.toolName,
      toolOutput: snap.toolOutput,
      toolState: "output-available",
      serverId: snap.serverId,
      isOffline: !!snap.widgetHtmlUrl,
      cachedWidgetHtmlUrl: snap.widgetHtmlUrl ?? undefined,
      resourceUri: snap.resourceUri,
      toolMetadata: snap.toolMetadata,
      widgetCsp: snap.widgetCsp as any,
      widgetPermissions: snap.widgetPermissions as any,
      widgetPermissive: snap.widgetPermissive,
      prefersBorder: snap.prefersBorder,
    });
    overrides[snap.toolCallId] = replay.renderOverride;
  }
  return overrides;
}

export interface TraceEnvelope {
  traceVersion?: 1;
  messages?: TraceSourceMessage[];
  widgetSnapshots?: TraceWidgetSnapshot[];
  spans?: EvalTraceSpan[];
  traceStartedAtMs?: number;
  traceEndedAtMs?: number;
  [key: string]: unknown;
}

export interface AdaptedTraceResult {
  messages: UIMessage[];
  toolRenderOverrides: Record<string, ToolRenderOverride>;
  uiMessageSourceRanges: Record<
    string,
    { startIndex: number; endIndex: number }
  >;
  sourceMessageIndexToUiMessageIds: Record<number, string[]>;
  sourceMessageIndexToFocusUiMessageId: Record<number, string>;
}

type ToolResultDisplay = "sibling-text" | "attached-to-tool";
type TraceDisplayMode = "markdown" | "json-markdown";

interface TraceToolResultEntry {
  part: TraceContentPart;
  messageIndex: number;
  partIndex: number;
}

interface AdaptedUiMessage {
  message: UIMessage;
  sourceRange: {
    startIndex: number;
    endIndex: number;
  };
  focusSourceIndices?: number[];
}

const EMPTY_TOOL_METADATA: Record<string, unknown> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unwrapTraceToolOutput(output: unknown): unknown {
  if (!isRecord(output)) return output;
  if (!("type" in output) || !("value" in output)) return output;
  return output.value;
}

function attachServerId<T>(value: T, serverId?: string): T {
  if (!serverId || !isRecord(value) || typeof value._serverId === "string") {
    return value;
  }

  return {
    ...value,
    _serverId: serverId,
  } as T;
}

function isWidgetUiType(uiType: UIType | null): boolean {
  return (
    uiType === UIType.OPENAI_SDK ||
    uiType === UIType.MCP_APPS ||
    uiType === UIType.OPENAI_SDK_AND_MCP_APPS
  );
}

function isUiResourceLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isUIResource(value as never)) return true;
  const resource = value.resource;
  return isRecord(resource) && typeof resource.uri === "string";
}

function scrubUiResourceContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => scrubUiResourceContent(item))
      .filter((item) => item !== undefined);
  }

  if (!isRecord(value)) return value;
  if (isUiResourceLike(value)) return undefined;

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "_meta" || key === "_serverId") continue;
    if (key === "resource" && isUiResourceLike({ resource: entry })) continue;

    const scrubbed = scrubUiResourceContent(entry);
    if (scrubbed !== undefined) {
      next[key] = scrubbed;
    }
  }

  return next;
}

function toMarkdownJson(value: unknown): string | null {
  if (value === undefined) return null;

  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return `\`\`\`\n${String(value)}\n\`\`\``;
  }
}

function resolveTraceMessages(
  trace: TraceEnvelope | TraceSourceMessage | TraceSourceMessage[] | null,
) {
  let messages: TraceSourceMessage[] = [];
  let widgetSnapshots: TraceWidgetSnapshot[] = [];

  if (Array.isArray(trace)) {
    messages = trace;
  } else if (
    isRecord(trace) &&
    "messages" in trace &&
    Array.isArray(trace.messages)
  ) {
    messages = trace.messages as TraceSourceMessage[];
    if ("widgetSnapshots" in trace && Array.isArray(trace.widgetSnapshots)) {
      widgetSnapshots = trace.widgetSnapshots as TraceWidgetSnapshot[];
    }
  } else if (isRecord(trace) && typeof trace.role === "string") {
    messages = [trace as unknown as TraceSourceMessage];
  }

  return { messages, widgetSnapshots };
}

function normalizeMessageContent(
  message: TraceSourceMessage,
): TraceContentPart[] {
  if (typeof message.content === "string") {
    return [
      {
        type: "text",
        text: message.content,
      },
    ];
  }

  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (part): part is TraceContentPart =>
      !!part && typeof part === "object" && typeof part.type === "string",
  );
}

function getToolName(part: TraceContentPart): string {
  const toolName = part.toolName ?? part.name;
  return typeof toolName === "string" && toolName.trim() ? toolName : "Tool";
}

function getToolInput(part: TraceContentPart): Record<string, unknown> {
  const input = part.input ?? part.parameters ?? part.args ?? {};
  return isRecord(input) ? input : {};
}

function getToolResultPayload(part: TraceContentPart): unknown {
  if (part.output !== undefined) {
    const unwrappedOutput = unwrapTraceToolOutput(part.output);
    return attachServerId(
      unwrappedOutput,
      typeof part.serverId === "string" ? part.serverId : undefined,
    );
  }

  if (part.result !== undefined) {
    return attachServerId(
      part.result,
      typeof part.serverId === "string" ? part.serverId : undefined,
    );
  }

  return undefined;
}

function getToolResultDisplayValue(
  part: TraceContentPart | undefined,
): unknown {
  if (!part) return undefined;
  if (part.result !== undefined) return part.result;
  return unwrapTraceToolOutput(part.output);
}

function getToolErrorText(
  part: TraceContentPart | undefined,
): string | undefined {
  if (!part) return undefined;
  const displayValue = getToolResultDisplayValue(part);

  if (typeof part.error === "string" && part.error.trim()) {
    return part.error.trim();
  }

  if (isRecord(part.error) && typeof part.error.message === "string") {
    return part.error.message;
  }

  if (isRecord(part.output) && part.output.type === "error-text") {
    return typeof part.output.value === "string"
      ? part.output.value
      : "Tool error";
  }

  if (isRecord(part.result) && part.result.isError === true) {
    const extracted = extractTextFromToolResult(displayValue);
    return extracted ?? "Tool error";
  }

  if (
    isRecord(part.output) &&
    isRecord(part.output.value) &&
    part.output.value.isError === true
  ) {
    const extracted = extractTextFromToolResult(displayValue);
    return extracted ?? "Tool error";
  }

  if (part.isError) {
    const extracted = extractTextFromToolResult(displayValue);
    return extracted ?? "Tool error";
  }

  return undefined;
}

function buildSyntheticToolCallId(
  messageIndex: number,
  partIndex: number,
  toolName: string,
) {
  return `trace-tool-${messageIndex}-${partIndex}-${toolName}`;
}

function createResultBuckets(entries: TraceToolResultEntry[]) {
  const keyed = new Map<string, TraceToolResultEntry[]>();
  const unkeyed: TraceToolResultEntry[] = [];

  for (const entry of entries) {
    const toolCallId = entry.part.toolCallId;
    if (typeof toolCallId === "string" && toolCallId) {
      const bucket = keyed.get(toolCallId) ?? [];
      bucket.push(entry);
      keyed.set(toolCallId, bucket);
    } else {
      unkeyed.push(entry);
    }
  }

  return { keyed, unkeyed };
}

function claimMatchingResult(
  resultBuckets: ReturnType<typeof createResultBuckets>,
  toolCallId: string,
  prefersUnkeyedFallback: boolean,
) {
  const keyedBucket = resultBuckets.keyed.get(toolCallId);
  if (keyedBucket && keyedBucket.length > 0) {
    return keyedBucket.shift();
  }

  if (prefersUnkeyedFallback) {
    return resultBuckets.unkeyed.shift();
  }

  return undefined;
}

function getRemainingResults(
  resultBuckets: ReturnType<typeof createResultBuckets>,
) {
  const keyed = [...resultBuckets.keyed.values()].flat();
  return [...keyed, ...resultBuckets.unkeyed];
}

function shouldAttemptWidgetReplay(params: {
  toolName: string;
  toolCallId: string;
  rawToolOutput: unknown;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: Set<string>;
  widgetSnapshotMap: Map<string, TraceWidgetSnapshot>;
}) {
  const snapshot = params.widgetSnapshotMap.get(params.toolCallId);
  const streamedToolMetadata = readToolResultMeta(params.rawToolOutput);
  const effectiveToolMetadata =
    snapshot?.toolMetadata ??
    params.toolsMetadata[params.toolName] ??
    streamedToolMetadata;
  const effectiveUiType = detectUIType(
    effectiveToolMetadata,
    params.rawToolOutput,
  );
  const effectiveServerId =
    snapshot?.serverId ??
    getToolServerId(params.toolName, params.toolServerMap) ??
    readToolResultServerId(params.rawToolOutput);
  const effectiveResourceUri =
    snapshot?.resourceUri ??
    getUIResourceUri(effectiveUiType, effectiveToolMetadata);

  return Boolean(
    effectiveServerId &&
    effectiveResourceUri &&
    isWidgetUiType(effectiveUiType) &&
    params.connectedServerIds.has(effectiveServerId),
  );
}

function createReplayOverride(
  snapshot: TraceWidgetSnapshot,
  toolInput: Record<string, unknown>,
  toolOutput: unknown,
) {
  const replayToolOutput = snapshot.toolOutput ?? toolOutput;
  return buildPersistedExecutionReplay({
    protocol: snapshot.protocol,
    toolCallId: snapshot.toolCallId,
    toolName: snapshot.toolName,
    toolInput,
    toolOutput: replayToolOutput,
    toolState: "output-available",
    toolMetadata: snapshot.toolMetadata,
    serverId: snapshot.serverId,
    isOffline: true,
    cachedWidgetHtmlUrl: snapshot.widgetHtmlUrl ?? undefined,
    resourceUri: snapshot.resourceUri,
    widgetCsp: snapshot.widgetCsp as any,
    widgetPermissions: snapshot.widgetPermissions as any,
    widgetPermissive: snapshot.widgetPermissive,
    prefersBorder: snapshot.prefersBorder,
  }).renderOverride;
}

function createLiveSnapshotOverride(snapshot: TraceWidgetSnapshot) {
  return {
    serverId: snapshot.serverId,
    toolOutput: snapshot.toolOutput,
    resourceUri: snapshot.resourceUri,
    toolMetadata: snapshot.toolMetadata,
    widgetCsp: snapshot.widgetCsp as any,
    widgetPermissions: snapshot.widgetPermissions as any,
    widgetPermissive: snapshot.widgetPermissive,
    prefersBorder: snapshot.prefersBorder,
  } satisfies ToolRenderOverride;
}

function getTraceDisplayAttachment(params: {
  displayedOutput: unknown;
  adaptedOutput: unknown;
  canReplayWidget: boolean;
}): { text: string; mode: TraceDisplayMode } | null {
  const extractedText = extractTextFromToolResult(params.displayedOutput);
  if (extractedText) {
    return {
      text: extractedText,
      mode: "markdown",
    };
  }

  if (params.canReplayWidget) {
    return null;
  }

  const jsonMarkdown = toMarkdownJson(params.adaptedOutput);
  if (!jsonMarkdown) {
    return null;
  }

  return {
    text: jsonMarkdown,
    mode: "json-markdown",
  };
}

function buildToolParts(params: {
  toolCall: TraceContentPart;
  matchedResult?: TraceContentPart;
  messageIndex: number;
  partIndex: number;
  widgetSnapshotMap: Map<string, TraceWidgetSnapshot>;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: Set<string>;
  toolRenderOverrides: Record<string, ToolRenderOverride>;
  toolResultDisplay: ToolResultDisplay;
}): UIMessage["parts"] {
  const toolName = getToolName(params.toolCall);
  const toolInput = getToolInput(params.toolCall);
  const toolCallId =
    params.toolCall.toolCallId ??
    params.matchedResult?.toolCallId ??
    buildSyntheticToolCallId(params.messageIndex, params.partIndex, toolName);
  const rawToolOutput = getToolResultPayload(
    params.matchedResult ?? params.toolCall,
  );
  const displayedOutput = getToolResultDisplayValue(params.matchedResult);
  const errorText = getToolErrorText(params.matchedResult);
  const isError = !!errorText;
  const snapshot = params.widgetSnapshotMap.get(toolCallId);
  const liveToolMetadata = params.toolsMetadata[toolName];
  const streamedToolMeta = readToolResultMeta(rawToolOutput);
  const effectiveToolMeta =
    snapshot?.toolMetadata ?? liveToolMetadata ?? streamedToolMeta;
  const widgetUiType = detectUIType(effectiveToolMeta, rawToolOutput);
  const canReplayWidget =
    !isError &&
    !!params.matchedResult &&
    shouldAttemptWidgetReplay({
      toolName,
      toolCallId,
      rawToolOutput,
      toolsMetadata: params.toolsMetadata,
      toolServerMap: params.toolServerMap,
      connectedServerIds: params.connectedServerIds,
      widgetSnapshotMap: params.widgetSnapshotMap,
    });

  let adaptedOutput = rawToolOutput;
  if (!isError && snapshot?.widgetHtmlUrl) {
    // Always use cached offline replay when snapshot has pre-bundled HTML
    params.toolRenderOverrides[toolCallId] = createReplayOverride(
      snapshot,
      toolInput,
      rawToolOutput,
    );
  } else if (canReplayWidget) {
    if (snapshot) {
      params.toolRenderOverrides[toolCallId] = {
        ...createLiveSnapshotOverride(snapshot),
        ...(params.toolRenderOverrides[toolCallId] ?? {}),
      };
    }
  } else if (!isError && isWidgetUiType(widgetUiType)) {
    // No replay possible — scrub widget metadata to prevent broken iframe
    adaptedOutput = scrubUiResourceContent(rawToolOutput);
    params.toolRenderOverrides[toolCallId] = {
      ...(params.toolRenderOverrides[toolCallId] ?? {}),
      toolMetadata: EMPTY_TOOL_METADATA,
    };
  }

  const traceDisplayAttachment =
    !isError && params.matchedResult
      ? getTraceDisplayAttachment({
          displayedOutput,
          adaptedOutput,
          canReplayWidget,
        })
      : null;

  const parts: UIMessage["parts"] = [];
  const toolPart: DynamicToolUIPart & {
    traceDisplayText?: string;
    traceDisplayMode?: TraceDisplayMode;
  } = isError
    ? {
        type: "dynamic-tool",
        toolCallId,
        toolName,
        state: "output-error",
        input: toolInput,
        errorText,
      }
    : params.matchedResult
      ? {
          type: "dynamic-tool",
          toolCallId,
          toolName,
          state: "output-available",
          input: toolInput,
          output: adaptedOutput,
        }
      : {
          type: "dynamic-tool",
          toolCallId,
          toolName,
          state: "input-available",
          input: toolInput,
        };
  if (
    params.toolResultDisplay === "attached-to-tool" &&
    traceDisplayAttachment
  ) {
    toolPart.traceDisplayText = traceDisplayAttachment.text;
    toolPart.traceDisplayMode = traceDisplayAttachment.mode;
  }
  parts.push(toolPart);

  if (isError) {
    parts.push({
      type: "text",
      text: `Tool error: ${errorText}`,
    });
    return parts;
  }

  if (!params.matchedResult) {
    return parts;
  }

  if (params.toolResultDisplay === "attached-to-tool") {
    return parts;
  }

  if (traceDisplayAttachment) {
    parts.push({
      type: "text",
      text: traceDisplayAttachment.text,
    });
  }

  return parts;
}

function adaptTracePart(
  part: TraceContentPart,
): UIMessage["parts"][number] | null {
  if (part.type === "tool-call" || part.type === "tool-result") {
    return null;
  }

  if (part.type === "text" && typeof part.text !== "string") {
    return null;
  }

  return part as UIMessage["parts"][number];
}

function buildAssistantMessage(params: {
  message: TraceSourceMessage;
  messageIndex: number;
  toolMessages: TraceSourceMessage[];
  widgetSnapshotMap: Map<string, TraceWidgetSnapshot>;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: Set<string>;
  toolRenderOverrides: Record<string, ToolRenderOverride>;
  toolResultDisplay: ToolResultDisplay;
}): { message: AdaptedUiMessage; extraMessages: AdaptedUiMessage[] } {
  const assistantParts = normalizeMessageContent(params.message);
  const toolResultEntries = params.toolMessages.flatMap(
    (toolMessage, toolMessageOffset) =>
      normalizeMessageContent(toolMessage)
        .map((part, partIndex) => ({
          part,
          messageIndex: params.messageIndex + toolMessageOffset + 1,
          partIndex,
        }))
        .filter((entry) => entry.part.type === "tool-result"),
  );
  const resultBuckets = createResultBuckets(toolResultEntries);
  const parts: UIMessage["parts"] = [];
  const focusSourceIndices = new Set<number>([params.messageIndex]);

  assistantParts.forEach((part, partIndex) => {
    if (part.type === "tool-call") {
      const toolCallId =
        part.toolCallId ??
        buildSyntheticToolCallId(
          params.messageIndex,
          partIndex,
          getToolName(part),
        );
      const matchedResultEntry = claimMatchingResult(
        resultBuckets,
        toolCallId,
        !part.toolCallId,
      );
      if (matchedResultEntry) {
        focusSourceIndices.add(matchedResultEntry.messageIndex);
      }
      const matchedResult = matchedResultEntry?.part;

      const toolCallWithId = part.toolCallId ? part : { ...part, toolCallId };

      parts.push(
        ...buildToolParts({
          toolCall: toolCallWithId,
          matchedResult,
          messageIndex: params.messageIndex,
          partIndex,
          widgetSnapshotMap: params.widgetSnapshotMap,
          toolsMetadata: params.toolsMetadata,
          toolServerMap: params.toolServerMap,
          connectedServerIds: params.connectedServerIds,
          toolRenderOverrides: params.toolRenderOverrides,
          toolResultDisplay: params.toolResultDisplay,
        }),
      );
      return;
    }

    const adaptedPart = adaptTracePart(part);
    if (adaptedPart) {
      parts.push(adaptedPart);
    }
  });

  const extraMessages = getRemainingResults(resultBuckets).map(
    (entry, orphanIndex) => {
      const toolName = getToolName(entry.part);
      const toolCallId =
        entry.part.toolCallId ??
        buildSyntheticToolCallId(
          entry.messageIndex,
          entry.partIndex,
          `${toolName}-${orphanIndex}`,
        );
      const syntheticToolCall: TraceContentPart = {
        type: "tool-call",
        toolCallId,
        toolName,
        input: {},
      };

      return {
        message: {
          id: `trace-assistant-orphan-${entry.messageIndex}-${entry.partIndex}`,
          role: "assistant",
          parts: buildToolParts({
            toolCall: syntheticToolCall,
            matchedResult: {
              ...entry.part,
              toolCallId,
              toolName,
            },
            messageIndex: entry.messageIndex,
            partIndex: entry.partIndex,
            widgetSnapshotMap: params.widgetSnapshotMap,
            toolsMetadata: params.toolsMetadata,
            toolServerMap: params.toolServerMap,
            connectedServerIds: params.connectedServerIds,
            toolRenderOverrides: params.toolRenderOverrides,
            toolResultDisplay: params.toolResultDisplay,
          }),
        } satisfies UIMessage,
        sourceRange: {
          startIndex: entry.messageIndex,
          endIndex: entry.messageIndex,
        },
        focusSourceIndices: [entry.messageIndex],
      } satisfies AdaptedUiMessage;
    },
  );

  return {
    message: {
      message: {
        id: `trace-${params.message.role}-${params.messageIndex}`,
        role: "assistant",
        parts,
      },
      sourceRange: {
        startIndex: params.messageIndex,
        endIndex: params.messageIndex + params.toolMessages.length,
      },
      focusSourceIndices: [...focusSourceIndices],
    },
    extraMessages,
  };
}

function buildUserMessage(
  message: TraceSourceMessage,
  messageIndex: number,
): AdaptedUiMessage {
  const parts = normalizeMessageContent(message)
    .map((part) => adaptTracePart(part))
    .filter((part): part is NonNullable<typeof part> => Boolean(part));

  return {
    message: {
      id: `trace-user-${messageIndex}`,
      role: "user",
      parts,
    },
    sourceRange: {
      startIndex: messageIndex,
      endIndex: messageIndex,
    },
    focusSourceIndices: [messageIndex],
  };
}

function buildOrphanToolMessages(params: {
  toolMessages: TraceSourceMessage[];
  startIndex: number;
  widgetSnapshotMap: Map<string, TraceWidgetSnapshot>;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: Set<string>;
  toolRenderOverrides: Record<string, ToolRenderOverride>;
  toolResultDisplay: ToolResultDisplay;
}) {
  return params.toolMessages.flatMap((message, messageOffset) =>
    normalizeMessageContent(message).flatMap((part, partIndex) => {
      if (part.type !== "tool-result") return [];
      const toolName = getToolName(part);
      const toolCallId =
        part.toolCallId ??
        buildSyntheticToolCallId(
          params.startIndex + messageOffset,
          partIndex,
          toolName,
        );

      return [
        {
          message: {
            id: `trace-assistant-orphan-${params.startIndex + messageOffset}-${partIndex}`,
            role: "assistant",
            parts: buildToolParts({
              toolCall: {
                type: "tool-call",
                toolCallId,
                toolName,
                input: {},
              },
              matchedResult: {
                ...part,
                toolCallId,
                toolName,
              },
              messageIndex: params.startIndex + messageOffset,
              partIndex,
              widgetSnapshotMap: params.widgetSnapshotMap,
              toolsMetadata: params.toolsMetadata,
              toolServerMap: params.toolServerMap,
              connectedServerIds: params.connectedServerIds,
              toolRenderOverrides: params.toolRenderOverrides,
              toolResultDisplay: params.toolResultDisplay,
            }),
          } satisfies UIMessage,
          sourceRange: {
            startIndex: params.startIndex + messageOffset,
            endIndex: params.startIndex + messageOffset,
          },
          focusSourceIndices: [params.startIndex + messageOffset],
        } satisfies AdaptedUiMessage,
      ];
    }),
  );
}

export function adaptTraceToUiMessages(params: {
  trace: TraceEnvelope | TraceSourceMessage | TraceSourceMessage[] | null;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
  connectedServerIds?: string[];
  toolResultDisplay?: ToolResultDisplay;
}): AdaptedTraceResult {
  const { messages, widgetSnapshots } = resolveTraceMessages(params.trace);
  const widgetSnapshotMap = new Map(
    widgetSnapshots.map((snapshot) => [snapshot.toolCallId, snapshot]),
  );
  const toolRenderOverrides: Record<string, ToolRenderOverride> = {};
  const uiMessages: UIMessage[] = [];
  const uiMessageSourceRanges: Record<
    string,
    { startIndex: number; endIndex: number }
  > = {};
  const sourceMessageIndexToUiMessageIds: Record<number, string[]> = {};
  const sourceMessageIndexToFocusUiMessageId: Record<number, string> = {};
  const toolsMetadata = params.toolsMetadata ?? {};
  const toolServerMap = params.toolServerMap ?? {};
  const connectedServerIds = new Set(params.connectedServerIds ?? []);
  const toolResultDisplay = params.toolResultDisplay ?? "sibling-text";

  function recordUiMessage(entry: AdaptedUiMessage): void {
    uiMessages.push(entry.message);
    uiMessageSourceRanges[entry.message.id] = entry.sourceRange;
    for (
      let sourceIndex = entry.sourceRange.startIndex;
      sourceIndex <= entry.sourceRange.endIndex;
      sourceIndex += 1
    ) {
      sourceMessageIndexToUiMessageIds[sourceIndex] ??= [];
      sourceMessageIndexToUiMessageIds[sourceIndex]!.push(entry.message.id);
    }
    for (const sourceIndex of entry.focusSourceIndices ?? []) {
      sourceMessageIndexToFocusUiMessageId[sourceIndex] = entry.message.id;
    }
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message.role === "user") {
      recordUiMessage(buildUserMessage(message, index));
      continue;
    }

    if (message.role === "assistant") {
      const toolMessages: TraceSourceMessage[] = [];
      let nextIndex = index + 1;
      while (messages[nextIndex]?.role === "tool") {
        toolMessages.push(messages[nextIndex]);
        nextIndex += 1;
      }

      const adaptedAssistant = buildAssistantMessage({
        message,
        messageIndex: index,
        toolMessages,
        widgetSnapshotMap,
        toolsMetadata,
        toolServerMap,
        connectedServerIds,
        toolRenderOverrides,
        toolResultDisplay,
      });
      recordUiMessage(adaptedAssistant.message);
      adaptedAssistant.extraMessages.forEach((entry) => recordUiMessage(entry));
      index = nextIndex - 1;
      continue;
    }

    if (message.role === "tool") {
      const toolMessages: TraceSourceMessage[] = [];
      let nextIndex = index;
      while (messages[nextIndex]?.role === "tool") {
        toolMessages.push(messages[nextIndex]);
        nextIndex += 1;
      }

      buildOrphanToolMessages({
        toolMessages,
        startIndex: index,
        widgetSnapshotMap,
        toolsMetadata,
        toolServerMap,
        connectedServerIds,
        toolRenderOverrides,
        toolResultDisplay,
      }).forEach((entry) => recordUiMessage(entry));
      index = nextIndex - 1;
    }
  }

  return {
    messages: uiMessages,
    toolRenderOverrides,
    uiMessageSourceRanges,
    sourceMessageIndexToUiMessageIds,
    sourceMessageIndexToFocusUiMessageId,
  };
}
