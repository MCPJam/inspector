import { type UIMessage } from "@ai-sdk/react";
import { generateId } from "ai";

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
  [key: string]: unknown;
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

function convertParts(content: unknown): UIMessage["parts"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const parts: UIMessage["parts"] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }

    const partType = part?.type;
    if (partType === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (partType === "tool-call") {
      // Use "dynamic-tool" format so that PartSwitch can access toolCallId
      // at the top level (required for toolRenderOverrides lookup).
      // Use "output-available" state (not "result") — the rendering pipeline
      // (WidgetReplay) checks for this state to decide whether to render.
      // Prefer the raw `output` payload when available because it preserves
      // widget metadata like `_meta.ui.resourceUri` and `_serverId`.
      parts.push({
        type: "dynamic-tool",
        toolCallId: part.toolCallId ?? part.id ?? generateId(),
        toolName: part.toolName ?? "unknown",
        state: "output-available" as const,
        input: part.args ?? part.input ?? {},
        output: part.output ?? part.result ?? {},
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
  for (const raw of mergedTranscript) {
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

    messages.push({
      id: msg.id ?? generateId(),
      role: uiRole,
      parts: convertParts(msg.content),
    } as UIMessage);
  }

  return messages;
}
