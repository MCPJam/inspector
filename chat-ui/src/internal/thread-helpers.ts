import {
  type UIDataTypes,
  type UIMessagePart,
  type UITools,
  type ToolUIPart,
  type DynamicToolUIPart,
} from "ai";
import type { UIMessage } from "@ai-sdk/react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  ShieldX,
  type LucideIcon,
} from "lucide-react";

// Ported verbatim from the inspector
// (`components/chat-v2/thread/thread-helpers.ts`). This module is pure (no
// providers, no inspector imports) and is the single source of the part/tool
// shape helpers for the read-only renderer.

export type AnyPart = UIMessagePart<UIDataTypes, UITools>;
export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "output-available"
  | "output-denied"
  | "output-error";

export type ToolInfo = {
  toolName: string;
  toolCallId?: string;
  toolState?: ToolState;
  input: Record<string, unknown> | undefined;
  output: unknown;
  rawOutput: unknown;
  errorText?: string;
};

export type McpResource = {
  uri: string;
  [key: string]: unknown;
};

export type ToolStateMeta = {
  Icon: LucideIcon;
  label: string;
  className: string;
};

// Hidden internal messages: widget-state-* and model-context-* are injected
// for the model but never rendered.
export function isHiddenInternalMessage(message: UIMessage): boolean {
  return (
    message.id?.startsWith("widget-state-") === true ||
    message.id?.startsWith("model-context-") === true
  );
}

export function isRenderableConversationMessage(message: UIMessage): boolean {
  if (isHiddenInternalMessage(message)) return false;
  return message.role === "user" || message.role === "assistant";
}

export function getRenderableConversationMessages(
  messages: UIMessage[],
): UIMessage[] {
  return messages.filter(isRenderableConversationMessage);
}

export function getLastRenderableConversationMessage(
  messages: UIMessage[],
): UIMessage | null {
  return getRenderableConversationMessages(messages).at(-1) ?? null;
}

export function hasRenderableConversationContent(message: UIMessage): boolean {
  const parts = Array.isArray(message.parts) ? message.parts : [];

  if (parts.length > 0) {
    return parts.some(
      (part) => (part as { type?: string }).type !== "step-start",
    );
  }

  if (typeof (message as { content?: unknown }).content === "string") {
    return ((message as { content?: string }).content ?? "").trim().length > 0;
  }

  return false;
}

export function groupAssistantPartsIntoSteps(parts: AnyPart[]): AnyPart[][] {
  const groups: AnyPart[][] = [];
  let current: AnyPart[] = [];
  for (const part of parts) {
    if ((part as { type?: string }).type === "step-start") {
      if (current.length > 0) groups.push(current);
      current = [];
      continue; // do not include the step-start part itself
    }
    current.push(part);
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0
    ? groups
    : [parts.filter((p) => (p as { type?: string }).type !== "step-start")];
}

export function isToolApprovalRequest(part: AnyPart): boolean {
  if (isDynamicTool(part)) {
    return (part as DynamicToolUIPart).state === "approval-requested";
  }
  if (isToolPart(part)) {
    return (part as { state?: string }).state === "approval-requested";
  }
  return false;
}

export function isToolPart(part: AnyPart): part is ToolUIPart<UITools> {
  const t = (part as { type?: unknown }).type;
  return typeof t === "string" && t.startsWith("tool-");
}

export function isDynamicTool(part: unknown): part is DynamicToolUIPart {
  return (
    !!part &&
    typeof (part as { type?: unknown }).type === "string" &&
    (part as { type?: unknown }).type === "dynamic-tool"
  );
}

export function getToolInfo(
  part: ToolUIPart<UITools> | DynamicToolUIPart,
): ToolInfo {
  if (isDynamicTool(part)) {
    return {
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      toolState: part.state as ToolState | undefined,
      input: part.input as Record<string, unknown>,
      output: part.output,
      rawOutput: part.output,
      errorText: (part as { errorText?: string }).errorText,
    };
  }
  const toolPart = part as {
    type: string;
    toolCallId?: string;
    state?: string;
    input?: Record<string, unknown>;
    output?: { value?: unknown } | unknown;
    errorText?: string;
    error?: string;
  };
  const rawOutput = toolPart.output;
  return {
    toolName: getToolNameFromType(toolPart.type),
    toolCallId: toolPart.toolCallId,
    toolState: toolPart.state as ToolState | undefined,
    input: toolPart.input,
    output: (toolPart.output as { value?: unknown })?.value ?? rawOutput,
    rawOutput,
    errorText: toolPart.errorText ?? toolPart.error,
  };
}

export function isDataPart(part: AnyPart): boolean {
  const t = (part as { type?: unknown }).type;
  return typeof t === "string" && t.startsWith("data-");
}

export function getDataLabel(type: string): string {
  if (type === "data-") return "Data";
  if (type === "data-result") return "Result";
  return `Data (${type.replace(/^data-/, "")})`;
}

export function getToolNameFromType(type: string | undefined): string {
  if (!type) return "Tool";
  return type.startsWith("tool-") ? type.replace(/^tool-/, "") : "Tool";
}

export function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolStateMeta(
  state: ToolState | undefined,
): ToolStateMeta | null {
  if (!state) return null;
  switch (state) {
    case "input-streaming":
      return {
        Icon: Loader2,
        label: "Input streaming",
        className: "h-4 w-4 animate-spin text-muted-foreground",
      };
    case "input-available":
      return {
        Icon: CheckCircle2,
        label: "Input available",
        className: "h-4 w-4 text-muted-foreground",
      };
    case "output-available":
      return {
        Icon: CheckCircle2,
        label: "Output available",
        className: "h-4 w-4 text-emerald-500",
      };
    case "approval-requested":
      return {
        Icon: ShieldAlert,
        label: "Approval requested",
        className: "h-4 w-4 text-amber-500",
      };
    case "output-denied":
      return {
        Icon: ShieldX,
        label: "Denied",
        className: "h-4 w-4 text-destructive",
      };
    case "output-error":
      return {
        Icon: AlertTriangle,
        label: "Output error",
        className: "h-4 w-4 text-destructive",
      };
    default:
      return null;
  }
}
