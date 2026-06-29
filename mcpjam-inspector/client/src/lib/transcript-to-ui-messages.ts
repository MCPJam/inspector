import { type UIMessage } from "@ai-sdk/react";
import {
  mergeMcpToolOriginMetadata,
  readMcpToolOriginServerId,
} from "@/shared/mcp-tool-origin-metadata";

/**
 * Convert a persisted transcript blob (array of message objects from the
 * backend chat ingestion) into UIMessage[] suitable for the AI SDK useChat hook.
 *
 * The transcript format is the "session trace" produced by
 * buildSessionTraceMessages in chatIngestion/common.ts. Each entry has at least
 * { role, content } where content may be a string or an array of parts.
 */

interface TranscriptPart {
  type?: string;
  text?: string;
  value?: string;
  content?: string;
  [key: string]: unknown;
}

interface TranscriptMessage {
  id?: string;
  role?: string;
  content?: string | TranscriptPart[];
  /** Stamped by the backend on persisted user messages in shared sessions. */
  senderUserId?: string;
  [key: string]: unknown;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readUiPartToolCallId(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const candidate = part as { toolCallId?: unknown };
  if (
    typeof candidate.toolCallId === "string" &&
    candidate.toolCallId.length > 0
  ) {
    return candidate.toolCallId;
  }
  return undefined;
}

function normalizeUiPartForContinuity(part: unknown): unknown {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return part;
  }

  const {
    id: _id,
    toolCallId: _toolCallId,
    ...rest
  } = part as Record<string, unknown>;
  return rest;
}

function getUiMessageContinuityKey(message: UIMessage): string {
  const toolCallIds = (message.parts ?? [])
    .map(readUiPartToolCallId)
    .filter((id): id is string => !!id);

  if (toolCallIds.length > 0) {
    return `${message.role}:tools:${toolCallIds.join("|")}`;
  }

  return `${message.role}:parts:${stableHash(
    (message.parts ?? []).map(normalizeUiPartForContinuity)
  )}`;
}

function getStableMessageId(msg: TranscriptMessage, index: number): string {
  if (typeof msg.id === "string" && msg.id.length > 0) {
    return msg.id;
  }
  return `transcript-${index}-${msg.role ?? "unknown"}-${stableHash(
    msg.content
  )}`;
}

function getStableToolCallId(
  part: TranscriptPart,
  messageIndex: number,
  partIndex: number
): string {
  const explicitId = readToolCallId(part);
  if (explicitId) return explicitId;

  return `transcript-tool-${messageIndex}-${partIndex}-${stableHash({
    args: part.args ?? part.input,
    toolName: part.toolName,
  })}`;
}

function readToolCallId(part: TranscriptPart): string | undefined {
  if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
    return part.toolCallId;
  }
  if (typeof part.id === "string" && part.id.length > 0) {
    return part.id;
  }
  return undefined;
}

function readToolOriginMetadata(
  part: TranscriptPart
): Record<string, unknown> | undefined {
  const metadataCandidates = [
    part.providerOptions,
    part.callProviderMetadata,
    part.resultProviderMetadata,
    part.providerMetadata,
  ];
  const providerMetadata = metadataCandidates.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
  );
  const directServerId =
    typeof part.serverId === "string" && part.serverId.length > 0
      ? part.serverId
      : undefined;
  const serverId =
    directServerId ??
    metadataCandidates
      .map((candidate) => readMcpToolOriginServerId(candidate))
      .find((candidate): candidate is string => !!candidate);
  return mergeMcpToolOriginMetadata(providerMetadata, serverId);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function unwrapJsonEnvelope(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const record = current as Record<string, unknown>;
    if (record.type !== "json" || !hasOwn(record, "value")) {
      return current;
    }
    current = record.value;
  }
  return current;
}

function isModelVisibleImageOutput(value: unknown): boolean {
  const output = unwrapJsonEnvelope(value);
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  if (record.type !== "content" || !Array.isArray(record.value)) {
    return false;
  }
  return record.value.some((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return false;
    }
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type === "text" && typeof partRecord.text === "string") {
      return (
        partRecord.text.startsWith("[image omitted:") ||
        partRecord.text.startsWith("[resource link omitted:") ||
        partRecord.text.startsWith("[embedded image resource omitted:")
      );
    }
    return (
      (partRecord.type === "media" || partRecord.type === "image-data") &&
      typeof partRecord.mediaType === "string" &&
      partRecord.mediaType.startsWith("image/")
    );
  });
}

function readHydratedToolOutput(part: TranscriptPart): unknown {
  const hasResult = hasOwn(part, "result");
  const hasOutput = hasOwn(part, "output");
  if (
    hasResult &&
    hasOutput &&
    isModelVisibleImageOutput(part.output)
  ) {
    return part.result;
  }
  if (hasOutput) return part.output;
  if (hasResult) return part.result;
  return {};
}

function cloneTranscriptMessage(msg: TranscriptMessage): TranscriptMessage {
  if (typeof msg.content === "string") {
    return { ...msg };
  }
  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          return { ...(p as object) } as TranscriptPart;
        }
        return p;
      }),
    };
  }
  return { ...msg };
}

/**
 * In persisted traces, tool outputs live in separate `role: tool` messages.
 * `convertToModelMessages` / the model require those results paired with the
 * assistant `tool-call` parts. Merge tool-result payloads into the matching
 * assistant tool-call parts, then drop standalone tool rows.
 */
export function mergeTranscriptToolResults(transcript: unknown[]): unknown[] {
  if (!Array.isArray(transcript)) return [];

  const out: unknown[] = [];

  for (const raw of transcript) {
    const msg = raw as TranscriptMessage;
    if (!msg || typeof msg !== "object") continue;

    if (msg.role === "tool") {
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const trPart of content) {
        if (typeof trPart !== "object" || trPart === null) continue;
        const tp = trPart as TranscriptPart;
        if (tp.type !== "tool-result") continue;

        const targetCallId = readToolCallId(tp);
        if (!targetCallId) continue;

        let patched = false;
        for (let i = out.length - 1; i >= 0 && !patched; i--) {
          const prior = out[i] as TranscriptMessage;
          if (prior?.role !== "assistant") continue;
          const ac = prior.content;
          if (!Array.isArray(ac)) continue;

          for (const part of ac) {
            if (typeof part !== "object" || part === null) continue;
            const p = part as TranscriptPart;
            if (p.type !== "tool-call") continue;
            if (readToolCallId(p) !== targetCallId) continue;

            const mergedResult =
              tp.result !== undefined ? tp.result : tp.output;
            if (mergedResult !== undefined) {
              p.result = mergedResult;
            }
            if (tp.output !== undefined) {
              p.output = tp.output;
            }
            const providerMetadata =
              readToolOriginMetadata(tp) ?? readToolOriginMetadata(p);
            if (providerMetadata) {
              p.providerOptions = providerMetadata;
            }
            patched = true;
            break;
          }
        }
      }
      continue;
    }

    out.push(cloneTranscriptMessage(msg));
  }

  return out;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part: TranscriptPart) => {
      if (typeof part === "string") return part;
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if (typeof part.value === "string") return part.value;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter((t: string) => t.length > 0)
    .join("\n");
}

function convertParts(
  content: unknown,
  messageIndex: number
): UIMessage["parts"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const parts: UIMessage["parts"] = [];
  for (const [partIndex, part] of content.entries()) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }

    const partType = part?.type;
    if (partType === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (partType === "tool-call") {
      const providerMetadata = readToolOriginMetadata(part);
      // Use "dynamic-tool" format so that PartSwitch can access toolCallId
      // at the top level (required for toolRenderOverrides lookup).
      // Use "output-available" state (not "result") — the rendering pipeline
      // (WidgetReplay) checks for this state to decide whether to render.
      // Preserve the UI/raw tool payload. Image tool traces may carry
      // model-facing media in `output` and raw MCP JSON in `result`; legacy
      // widget traces may carry raw widget data in `output`.
      parts.push({
        type: "dynamic-tool",
        toolCallId: getStableToolCallId(part, messageIndex, partIndex),
        toolName: part.toolName ?? "unknown",
        state: "output-available" as const,
        input: part.args ?? part.input ?? {},
        output: readHydratedToolOutput(part),
        ...(providerMetadata
          ? { callProviderMetadata: providerMetadata }
          : {}),
      } as any);
    } else if (partType === "tool-result") {
      // Tool results are typically already captured via tool-call results
      // in the AI SDK format, so we skip standalone tool-result parts.
    } else if (typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (typeof part.value === "string") {
      parts.push({ type: "text", text: part.value });
    }
  }

  if (parts.length === 0) {
    parts.push({ type: "text", text: extractTextContent(content) });
  }

  return parts;
}

export function transcriptToUIMessages(transcript: unknown[]): UIMessage[] {
  if (!Array.isArray(transcript)) return [];

  const mergedTranscript = mergeTranscriptToolResults(transcript);
  const messages: UIMessage[] = [];
  for (const [index, raw] of mergedTranscript.entries()) {
    const msg = raw as TranscriptMessage;
    if (!msg || typeof msg !== "object") continue;

    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    // role=tool rows are stripped by mergeTranscriptToolResults
    const uiRole =
      role === "system"
        ? ("system" as const)
        : role === "user"
        ? ("user" as const)
        : ("assistant" as const);

    const senderUserId =
      typeof msg.senderUserId === "string" && msg.senderUserId.length > 0
        ? msg.senderUserId
        : undefined;

    messages.push({
      id: getStableMessageId(msg, index),
      role: uiRole,
      parts: convertParts(msg.content, index),
      ...(senderUserId
        ? { metadata: { senderUserId } as Record<string, unknown> }
        : {}),
    } as UIMessage);
  }

  return messages;
}

export function preserveHydratedMessageIds(
  currentMessages: UIMessage[],
  hydratedMessages: UIMessage[]
): UIMessage[] {
  if (currentMessages.length === 0 || hydratedMessages.length === 0) {
    return hydratedMessages;
  }

  const currentIdsByContinuityKey = new Map<string, string[]>();
  for (const message of currentMessages) {
    const key = getUiMessageContinuityKey(message);
    const ids = currentIdsByContinuityKey.get(key);
    if (ids) {
      ids.push(message.id);
    } else {
      currentIdsByContinuityKey.set(key, [message.id]);
    }
  }

  return hydratedMessages.map((message) => {
    const key = getUiMessageContinuityKey(message);
    const existingId = currentIdsByContinuityKey.get(key)?.shift();
    if (!existingId || existingId === message.id) return message;
    return { ...message, id: existingId };
  });
}
