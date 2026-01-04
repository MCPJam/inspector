import {
  UIDataTypes,
  UIMessagePart,
  UITools,
  ToolUIPart,
  DynamicToolUIPart,
} from "ai";
import { isUIResource } from "@mcp-ui/client";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  type LucideIcon,
} from "lucide-react";

export type AnyPart = UIMessagePart<UIDataTypes, UITools>;
export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

type ToolInfo = {
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

type ToolStateMeta = {
  Icon: LucideIcon;
  label: string;
  className: string;
};

export function groupAssistantPartsIntoSteps(parts: AnyPart[]): AnyPart[][] {
  const groups: AnyPart[][] = [];
  let current: AnyPart[] = [];
  for (const part of parts) {
    if ((part as any).type === "step-start") {
      if (current.length > 0) groups.push(current);
      current = [];
      continue; // do not include the step-start part itself
    }
    current.push(part);
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0
    ? groups
    : [parts.filter((p) => (p as any).type !== "step-start")];
}

export function isToolPart(part: AnyPart): part is ToolUIPart<UITools> {
  const t = (part as any).type;
  return typeof t === "string" && t.startsWith("tool-");
}

export function isDynamicTool(part: unknown): part is DynamicToolUIPart {
  return (
    !!part &&
    typeof (part as any).type === "string" &&
    (part as any).type === "dynamic-tool"
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
  const toolPart = part as any;
  const rawOutput = toolPart.output;
  return {
    toolName: getToolNameFromType(toolPart.type),
    toolCallId: toolPart.toolCallId,
    toolState: toolPart.state as ToolState | undefined,
    input: toolPart.input,
    output: toolPart.output?.value ?? rawOutput,
    rawOutput,
    errorText: toolPart.errorText ?? toolPart.error,
  };
}

export function extractUIResource(
  toolResult: unknown,
): { resource: McpResource } | null {
  const content =
    (toolResult as { value?: { content?: unknown[] } })?.value?.content ??
    (toolResult as { content?: unknown[] })?.content;
  if (!Array.isArray(content)) return null;
  const found = content.find((item) => isUIResource(item as any));
  return (found as { resource: McpResource } | undefined) ?? null;
}

export function isDataPart(part: AnyPart): boolean {
  const t = (part as any).type;
  return typeof t === "string" && t.startsWith("data-");
}

export function getDataLabel(type: string): string {
  return type === "data-" ? "Data" : `Data (${type.replace(/^data-/, "")})`;
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
