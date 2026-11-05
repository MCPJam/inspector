import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  mergeMcpToolOriginMetadata,
  readMcpToolOriginServerId,
  type McpToolOriginProviderMetadata,
  readMcpOriginalResult,
  hasMcpResultPresentation,
} from "@/shared/mcp-tool-origin-metadata";
import { isRecord } from "../../byok/list-request.js";

export type NativeResultPresentation = {
  result: unknown;
  metadata: McpToolOriginProviderMetadata | undefined;
};

/** Persist UI evidence beside the vendor output; never change the running model history. */
export function presentNativeTranscript(
  messages: ModelMessage[],
  presentations: ReadonlyMap<string, NativeResultPresentation>,
): ModelMessage[] {
  if (!presentations.size) return messages;
  const normalized = messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      return [message];
    const normalized: ModelMessage[] = [];
    let content: typeof message.content = [];
    for (const part of message.content) {
      if (part.type === "tool-result" && presentations.has(part.toolCallId)) {
        if (content.length) normalized.push({ ...message, content });
        content = [];
        normalized.push({ role: "tool", content: [part] });
      } else content.push(part);
    }
    if (content.length) normalized.push({ ...message, content });
    return normalized;
  });
  return normalized.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        const presentation = presentations.get(part.toolCallId);
        if (!presentation || "result" in part) return part;
        const original = part.providerOptions?.mcpjam;
        return {
          ...part,
          result: presentation.result,
          providerOptions: mergeMcpToolOriginMetadata(
            {
              ...part.providerOptions,
              ...presentation.metadata,
              mcpjam: {
                ...(original &&
                typeof original === "object" &&
                !Array.isArray(original)
                  ? original
                  : {}),
                ...presentation.metadata?.mcpjam,
              },
            },
            readMcpToolOriginServerId(part.providerOptions),
          ),
        };
      }),
    };
  });
}

/** Called after history verification, so client-changed presentation data was removed. */
export function preserveNativeUiPresentations(
  messages: ModelMessage[],
  uiMessages: readonly unknown[],
) {
  const presentations = new Map<string, NativeResultPresentation>();
  for (const message of uiMessages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || typeof part.toolCallId !== "string") continue;
      const serverId =
        readMcpToolOriginServerId(part.callProviderMetadata) ??
        readMcpToolOriginServerId(part.resultProviderMetadata);
      for (const metadata of [
        part.resultProviderMetadata,
        part.callProviderMetadata,
      ]) {
        const result = readMcpOriginalResult(metadata);
        if (result !== undefined) {
          const restored = mergeMcpToolOriginMetadata(metadata, serverId);
          const callOrigin = mergeMcpToolOriginMetadata(
            part.callProviderMetadata,
            serverId,
          );
          // The call carries account attribution too; it is not model context.
          if (
            restored &&
            callOrigin?.mcpjam?.connection &&
            !restored.mcpjam?.connection
          )
            restored.mcpjam = {
              ...restored.mcpjam,
              connection: callOrigin.mcpjam.connection,
            };
          presentations.set(part.toolCallId, {
            result,
            metadata: restored,
          });
        }
      }
    }
  }
  return presentNativeTranscript(messages, presentations);
}

export const PRESENTATION_SIGNATURE_FIELD = "presentationSig";

export function stampNativePresentation(
  ctx: import("../../history-provenance").ProvenanceContext,
  call: import("../../history-provenance").ToolCallClaim,
  metadata: unknown,
  fallback: unknown,
  sign: typeof import("../../history-provenance").signToolResult,
) {
  const original =
    readMcpOriginalResult(metadata) ??
    (hasMcpResultPresentation(metadata) ? fallback : undefined);
  const signature =
    original === undefined ? null : sign(ctx, { ...call, output: original });
  if (!signature) return metadata;
  const base = isRecord(metadata) ? metadata : {};
  const mcpjam = isRecord(base.mcpjam) ? base.mcpjam : {};
  return {
    ...base,
    mcpjam: { ...mcpjam, [PRESENTATION_SIGNATURE_FIELD]: signature },
  };
}
