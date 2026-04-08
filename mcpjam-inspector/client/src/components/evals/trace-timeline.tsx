import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Layers,
  ListTree,
  MessageSquareQuote,
  Minus,
  Plus,
  Wrench,
} from "lucide-react";
import type { EvalTraceSpan, EvalTraceSpanCategory } from "@/shared/eval-trace";
import { MemoizedMarkdown } from "@/components/chat-v2/thread/memomized-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { extractTextFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import { cn } from "@/lib/utils";
import {
  RecordedTraceToolbar,
  type TimelineFilter,
} from "./recorded-trace-toolbar";

const ALL_AXIS_TICK_PERCENTS = [0, 25, 50, 75, 100] as const;

/**
 * Approximate horizontal space needed per tick (10px tabular nums; labels like "9.99s" are wide).
 */
const AXIS_TICK_MIN_GAP_PX = 54;

/** When only [0,100] ticks fit but the track is narrower than this, draw one range label (endpoints collide). */
const AXIS_SINGLE_RANGE_LABEL_BELOW_PX = 120;

/**
 * Chooses tick positions for the time axis based on measured column width.
 * Exported for unit tests.
 */
export function selectAxisTickPercents(widthPx: number): number[] {
  if (!Number.isFinite(widthPx)) {
    return [0, 100];
  }
  // Unmeasured (initial render) or zero-sized: avoid stacking many labels in one column.
  if (widthPx <= 0) {
    return [0, 100];
  }
  const maxTicks = Math.max(2, Math.floor(widthPx / AXIS_TICK_MIN_GAP_PX));
  if (maxTicks >= ALL_AXIS_TICK_PERCENTS.length) {
    return [...ALL_AXIS_TICK_PERCENTS];
  }
  if (maxTicks <= 2) {
    return [0, 100];
  }
  if (maxTicks === 3) {
    return [0, 50, 100];
  }
  return [0, 25, 75, 100];
}

function axisTickLabelAlignClass(tick: number): string {
  if (tick <= 0) {
    return "left-0 top-1/2 -translate-x-0 -translate-y-1/2 text-left";
  }
  if (tick >= 100) {
    return "left-0 top-1/2 -translate-x-full -translate-y-1/2 text-right";
  }
  return "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center";
}

function formatAxisRangeLabel(axisMaxMs: number): string {
  if (axisMaxMs <= 0) {
    return formatAxisLabel(0);
  }
  return `${formatAxisLabel(0)}–${formatAxisLabel(axisMaxMs)}`;
}

export type { TimelineFilter };

type TranscriptMessage = {
  role: string;
  content?: unknown;
};

type TraceNode = {
  span: EvalTraceSpan;
  children: TraceNode[];
};

type PromptGroup = {
  key: string;
  promptIndex: number;
  label: string;
  spans: EvalTraceSpan[];
  roots: TraceNode[];
  startMs: number;
  endMs: number;
  messageStartIndex?: number;
  messageEndIndex?: number;
  counts: Record<EvalTraceSpanCategory, number>;
};

type PromptRow = {
  kind: "prompt";
  key: string;
  promptIndex: number;
  label: string;
  /** User message preview when available, e.g. `User: "Draw me a flowchart..."` */
  conversationLabel?: string;
  startMs: number;
  endMs: number;
  messageStartIndex?: number;
  messageEndIndex?: number;
  counts: Record<EvalTraceSpanCategory, number>;
  /** Includes transcript-derived tool failures, not only category:error spans. */
  hasAnyFailure: boolean;
  isExpanded: boolean;
  /** Sum of token fields across `category === "llm"` spans in this group, when recorded. */
  aggregatedInputTokens?: number;
  aggregatedOutputTokens?: number;
  aggregatedTotalTokens?: number;
};

type SpanRow = {
  kind: "span";
  key: string;
  promptIndex: number;
  depth: number;
  span: EvalTraceSpan;
  hasChildren: boolean;
  isExpanded: boolean;
};

type TimelineRow = PromptRow | SpanRow;

function aggregateLlmTokenTotals(spans: EvalTraceSpan[]): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const llm = spans.filter((s) => s.category === "llm");
  let inputSum = 0;
  let inputN = 0;
  let outputSum = 0;
  let outputN = 0;
  let totalSum = 0;
  let totalN = 0;
  for (const s of llm) {
    if (typeof s.inputTokens === "number") {
      inputSum += s.inputTokens;
      inputN++;
    }
    if (typeof s.outputTokens === "number") {
      outputSum += s.outputTokens;
      outputN++;
    }
    if (typeof s.totalTokens === "number") {
      totalSum += s.totalTokens;
      totalN++;
    }
  }
  return {
    ...(inputN ? { inputTokens: inputSum } : {}),
    ...(outputN ? { outputTokens: outputSum } : {}),
    ...(totalN ? { totalTokens: totalSum } : {}),
  };
}

type TranscriptRange = {
  startIndex: number;
  endIndex: number;
};

export type TraceRevealSelection = {
  focusSourceIndex: number;
  highlightSourceIndices: number[];
};

function categoryRank(category: EvalTraceSpanCategory): number {
  switch (category) {
    case "step":
      return 0;
    case "llm":
      return 1;
    case "tool":
      return 2;
    case "error":
      return 3;
    default:
      return 9;
  }
}

function compareSpans(a: EvalTraceSpan, b: EvalTraceSpan): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  const categoryDiff = categoryRank(a.category) - categoryRank(b.category);
  if (categoryDiff !== 0) return categoryDiff;
  if (a.endMs !== b.endMs) return a.endMs - b.endMs;
  return a.name.localeCompare(b.name);
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatAxisLabel(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function partToolName(part: Record<string, unknown>): string | undefined {
  const toolName = part.toolName ?? part.name;
  return typeof toolName === "string" && toolName.trim() ? toolName : undefined;
}

function getMessageParts(
  message: TranscriptMessage,
): Record<string, unknown>[] {
  if (!Array.isArray(message.content)) {
    return typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  }

  return message.content.filter(
    (part): part is Record<string, unknown> =>
      isRecord(part) && typeof part.type === "string",
  );
}

function summarizeValue(value: unknown): string {
  if (value == null) return "None";
  if (typeof value === "string") {
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length > 0
      ? `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", ..." : ""} }`
      : "{}";
  }

  return String(value);
}

function formatMessageSummary(message: TranscriptMessage): string {
  const parts = getMessageParts(message);
  if (parts.length === 0) {
    return typeof message.content === "string" ? message.content : "No content";
  }

  const summary = parts
    .slice(0, 3)
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "tool-call") {
        return `Tool call: ${partToolName(part) ?? "Tool"}`;
      }
      if (part.type === "tool-result") {
        return `Tool result: ${partToolName(part) ?? "Tool"}`;
      }
      if (typeof part.type === "string") {
        return part.type;
      }
      return "content";
    })
    .join(" | ");

  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

/** Match AI SDK / trace envelope tool output wrapper `{ type, value }`. */
function unwrapTraceToolOutput(output: unknown): unknown {
  if (!isRecord(output)) return output;
  if (!("type" in output) || !("value" in output)) return output;
  return output.value;
}

function toolResultDisplayValue(part: Record<string, unknown>): unknown {
  if (part.result !== undefined) return part.result;
  return unwrapTraceToolOutput(part.output);
}

/** Mirrors trace-viewer-adapter `getToolErrorText` for raw transcript parts. */
function toolResultPartErrorText(
  part: Record<string, unknown>,
): string | undefined {
  const displayValue = toolResultDisplayValue(part);

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
    return extractTextFromToolResult(displayValue) ?? "Tool error";
  }

  if (
    isRecord(part.output) &&
    isRecord(part.output.value) &&
    part.output.value.isError === true
  ) {
    return extractTextFromToolResult(displayValue) ?? "Tool error";
  }

  if (part.isError === true) {
    return extractTextFromToolResult(displayValue) ?? "Tool error";
  }

  return undefined;
}

function extractToolData(
  messages: TranscriptMessage[],
  toolCallId?: string,
  toolName?: string,
): {
  input?: unknown;
  output?: unknown;
  errorText?: string;
} {
  if (!toolCallId && !toolName) {
    return {};
  }

  let input: unknown;
  let output: unknown;
  let errorText: string | undefined;

  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      const matchesToolCallId =
        typeof toolCallId === "string" && part.toolCallId === toolCallId;
      const matchesToolName =
        !matchesToolCallId &&
        typeof toolName === "string" &&
        partToolName(part) === toolName;

      if (!matchesToolCallId && !matchesToolName) {
        continue;
      }

      if (part.type === "tool-call") {
        input = part.input ?? part.parameters ?? part.args;
      }

      if (part.type === "tool-result") {
        output =
          part.result ??
          (isRecord(part.output) && "value" in part.output
            ? part.output.value
            : part.output);
        const fromPart = toolResultPartErrorText(part);
        if (fromPart) {
          errorText = fromPart;
        }
      }
    }
  }

  return { input, output, errorText };
}

function spanIndicatesTranscriptFailure(
  span: EvalTraceSpan,
  messages: TranscriptMessage[],
): boolean {
  if (span.category === "error") return true;
  if (span.status === "error") return true;
  if (span.category === "tool") {
    return Boolean(
      extractToolData(messages, span.toolCallId, span.toolName ?? span.name)
        .errorText,
    );
  }
  return false;
}

function getTranscriptRange(
  startIndex: number | undefined,
  endIndex: number | undefined,
): TranscriptRange | undefined {
  if (typeof startIndex !== "number" && typeof endIndex !== "number") {
    return undefined;
  }

  const start = startIndex ?? endIndex ?? 0;
  const end = endIndex ?? startIndex ?? start;
  return {
    startIndex: Math.min(start, end),
    endIndex: Math.max(start, end),
  };
}

function getPromptRowTranscriptRange(
  row: PromptRow,
): TranscriptRange | undefined {
  return getTranscriptRange(row.messageStartIndex, row.messageEndIndex);
}

function getSpanRowTranscriptRange(row: SpanRow): TranscriptRange | undefined {
  return getTranscriptRange(
    row.span.messageStartIndex,
    row.span.messageEndIndex,
  );
}

function getSourceIndicesForRange(
  range: TranscriptRange | undefined,
): number[] {
  if (!range) return [];
  const indices: number[] = [];
  for (let index = range.startIndex; index <= range.endIndex; index += 1) {
    indices.push(index);
  }
  return indices;
}

function findMessageIndexInRange(
  messages: TranscriptMessage[],
  range: TranscriptRange | undefined,
  predicate: (message: TranscriptMessage) => boolean,
): number | undefined {
  if (!range) return undefined;
  for (let index = range.startIndex; index <= range.endIndex; index += 1) {
    const message = messages[index];
    if (message && predicate(message)) {
      return index;
    }
  }
  return undefined;
}

function findUserMessageIndexForRange(
  messages: TranscriptMessage[],
  startIndex?: number,
  endIndex?: number,
): number | undefined {
  if (!messages.length) return undefined;
  const range = getTranscriptRange(startIndex, endIndex);
  if (!range) {
    const userMessageIndex = messages.findIndex(
      (message) => message.role === "user",
    );
    return userMessageIndex >= 0 ? userMessageIndex : undefined;
  }
  const inRangeIndex = findMessageIndexInRange(
    messages,
    range,
    (message) => message.role === "user",
  );
  if (typeof inRangeIndex === "number") {
    return inRangeIndex;
  }

  if (range && range.startIndex > 0) {
    for (let index = range.startIndex - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "user") {
        return index;
      }
      if (message.role === "assistant") {
        break;
      }
    }
  }

  return undefined;
}

function getWaterfallBarClass(
  row: TimelineRow,
  spanShowsFailure: boolean,
): string {
  if (row.kind === "prompt") return "trace-waterfall-bar-prompt";
  if (row.kind === "span" && spanShowsFailure) {
    return "trace-waterfall-bar-error";
  }
  if (row.kind !== "span") return "trace-waterfall-bar-step";
  switch (row.span.category) {
    case "llm":
      return "trace-waterfall-bar-llm";
    case "tool":
      return "trace-waterfall-bar-tool";
    case "step":
      return "trace-waterfall-bar-step";
    case "error":
      return "trace-waterfall-bar-error";
    default:
      return "trace-waterfall-bar-step";
  }
}

function getCategoryIconClass(
  category: EvalTraceSpanCategory | "prompt",
): string {
  switch (category) {
    case "prompt":
      return "trace-waterfall-glyph-prompt";
    case "step":
      return "trace-waterfall-glyph-step";
    case "llm":
      return "trace-waterfall-glyph-llm";
    case "tool":
      return "trace-waterfall-glyph-tool";
    case "error":
      return "trace-waterfall-glyph-error";
    default:
      return "text-muted-foreground";
  }
}

function getRowBorderAccentClass(
  row: TimelineRow,
  spanShowsFailure: boolean,
): string {
  if (row.kind === "prompt") {
    return "trace-waterfall-row-accent-prompt";
  }
  const cat = spanShowsFailure ? "error" : row.span.category;
  switch (cat) {
    case "llm":
      return "trace-waterfall-row-accent-llm";
    case "tool":
      return "trace-waterfall-row-accent-tool";
    case "error":
      return "trace-waterfall-row-accent-error";
    case "step":
      return "trace-waterfall-row-accent-step";
    default:
      return "border-l-muted-foreground";
  }
}

export function buildPromptGroups(spans: EvalTraceSpan[]): PromptGroup[] {
  const spansByPrompt = new Map<number, EvalTraceSpan[]>();
  for (const span of spans) {
    const promptIndex =
      typeof span.promptIndex === "number" ? span.promptIndex : 0;
    const existing = spansByPrompt.get(promptIndex);
    if (existing) {
      existing.push(span);
    } else {
      spansByPrompt.set(promptIndex, [span]);
    }
  }

  return [...spansByPrompt.entries()]
    .sort(([a], [b]) => a - b)
    .map(([promptIndex, promptSpans]) => {
      const nodesById = new Map<string, TraceNode>();
      promptSpans.forEach((span) => {
        nodesById.set(span.id, {
          span,
          children: [],
        });
      });

      const roots: TraceNode[] = [];
      promptSpans.forEach((span) => {
        const node = nodesById.get(span.id)!;
        const parent =
          typeof span.parentId === "string"
            ? nodesById.get(span.parentId)
            : undefined;
        if (parent) {
          parent.children.push(node);
          return;
        }
        roots.push(node);
      });

      const sortNodes = (nodes: TraceNode[]) => {
        nodes.sort((a, b) => compareSpans(a.span, b.span));
        nodes.forEach((node) => sortNodes(node.children));
      };
      sortNodes(roots);

      const messageIndices = promptSpans.flatMap((span) => {
        const values: number[] = [];
        if (typeof span.messageStartIndex === "number") {
          values.push(span.messageStartIndex);
        }
        if (typeof span.messageEndIndex === "number") {
          values.push(span.messageEndIndex);
        }
        return values;
      });

      const counts: Record<EvalTraceSpanCategory, number> = {
        step: 0,
        llm: 0,
        tool: 0,
        error: 0,
      };
      for (const span of promptSpans) {
        if (span.category in counts) {
          counts[span.category]++;
        }
      }

      return {
        key: `prompt-${promptIndex}`,
        promptIndex,
        label: `Prompt ${promptIndex + 1}`,
        spans: promptSpans,
        roots,
        startMs: Math.min(...promptSpans.map((span) => span.startMs)),
        endMs: Math.max(...promptSpans.map((span) => span.endMs)),
        messageStartIndex:
          messageIndices.length > 0 ? Math.min(...messageIndices) : undefined,
        messageEndIndex:
          messageIndices.length > 0 ? Math.max(...messageIndices) : undefined,
        counts,
      };
    });
}

export function collectStepSpanIdsWithChildren(
  groups: PromptGroup[],
): Set<string> {
  const ids = new Set<string>();
  function walk(nodes: TraceNode[]) {
    for (const node of nodes) {
      if (node.span.category === "step" && node.children.length > 0) {
        ids.add(node.span.id);
      }
      walk(node.children);
    }
  }
  for (const group of groups) {
    walk(group.roots);
  }
  return ids;
}

function toPlainTranscriptMessage(
  message: TranscriptMessage,
): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
  };
}

/**
 * Full conversation context sent to the model before the assistant reply for this span:
 * all transcript messages from index 0 up to (but not including) the first assistant
 * message within the span's message range. If there is no assistant in-range, returns
 * messages through `endIndex` (inclusive).
 */
function getLlmInputMessages(
  messages: TranscriptMessage[],
  startIndex?: number,
  endIndex?: number,
): TranscriptMessage[] {
  const range = getTranscriptRange(startIndex, endIndex);
  if (!range) return [];
  const slice = messages.slice(range.startIndex, range.endIndex + 1);
  if (slice.length === 0) return [];

  let firstAssistantInSlice = -1;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i]!.role === "assistant") {
      firstAssistantInSlice = i;
      break;
    }
  }

  if (firstAssistantInSlice < 0) {
    return messages.slice(0, range.endIndex + 1);
  }

  const absoluteFirstAssistant = range.startIndex + firstAssistantInSlice;
  if (absoluteFirstAssistant === 0) return [];
  return messages.slice(0, absoluteFirstAssistant);
}

/** Split transcript slice into model input messages vs last assistant output (same range as LLM span). */
function extractLlmTranscriptIo(
  messages: TranscriptMessage[],
  startIndex?: number,
  endIndex?: number,
): { input: unknown; output: unknown } {
  const range = getTranscriptRange(startIndex, endIndex);
  if (!range) {
    return { input: null, output: null };
  }
  const slice = messages.slice(range.startIndex, range.endIndex + 1);
  if (slice.length === 0) {
    return { input: [], output: null };
  }

  let lastAssistant = -1;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    if (slice[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }

  if (lastAssistant < 0) {
    return {
      input: slice.map(toPlainTranscriptMessage),
      output: null,
    };
  }

  const inputSlice = getLlmInputMessages(messages, startIndex, endIndex);
  const outMsg = slice[lastAssistant]!;
  return {
    input:
      inputSlice.length > 0 ? inputSlice.map(toPlainTranscriptMessage) : null,
    output: toPlainTranscriptMessage(outMsg),
  };
}

const ROW_SUBTITLE_MAX = 96;

function truncateRowSubtitle(text: string, max = ROW_SUBTITLE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function flattenTextFromMessage(message: TranscriptMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  const parts = getMessageParts(message);
  return parts
    .map((p) => {
      if (p.type === "text" && typeof p.text === "string") {
        return (p.text as string).trim();
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function toolCallNamesFromAssistantMessage(
  message: TranscriptMessage,
): string[] {
  const parts = getMessageParts(message);
  const names: string[] = [];
  for (const part of parts) {
    if (part.type === "tool-call") {
      names.push(partToolName(part) ?? "tool");
    }
  }
  return names;
}

/** Best-effort one-line preview of the prompt / context for an LLM or step span. */
function promptPreviewForLlmSpan(
  messages: TranscriptMessage[],
  span: EvalTraceSpan,
): string | undefined {
  if (!messages.length) return undefined;
  const inputMsgs = getLlmInputMessages(
    messages,
    span.messageStartIndex,
    span.messageEndIndex,
  );
  if (inputMsgs.length === 0) return undefined;

  for (let i = inputMsgs.length - 1; i >= 0; i--) {
    const m = inputMsgs[i]!;
    if (m.role === "user") {
      const t = flattenTextFromMessage(m);
      if (t) return truncateRowSubtitle(t);
    }
  }
  for (const m of inputMsgs) {
    if (m.role === "system") {
      const t = flattenTextFromMessage(m);
      if (t) return truncateRowSubtitle(t);
    }
  }
  for (let i = inputMsgs.length - 1; i >= 0; i--) {
    const m = inputMsgs[i]!;
    if (m.role === "tool") {
      const s = formatMessageSummary(m);
      if (s && s !== "No content") return truncateRowSubtitle(s);
    }
  }
  return undefined;
}

type LlmAssistantRowPreview =
  | { kind: "text"; preview: string }
  | { kind: "tools"; preview: string };

/** Preview from the last assistant message(s) in-range: user-visible text, else tool-call names. */
function assistantPreviewForLlmSpan(
  messages: TranscriptMessage[],
  span: EvalTraceSpan,
): LlmAssistantRowPreview | undefined {
  if (!messages.length) return undefined;
  const range = getTranscriptRange(
    span.messageStartIndex,
    span.messageEndIndex,
  );
  if (!range) return undefined;
  const slice = messages.slice(range.startIndex, range.endIndex + 1);
  for (let i = slice.length - 1; i >= 0; i--) {
    const m = slice[i]!;
    if (m.role !== "assistant") continue;
    const t = flattenTextFromMessage(m);
    if (t) {
      return { kind: "text", preview: truncateRowSubtitle(t) };
    }
    const toolNames = toolCallNamesFromAssistantMessage(m);
    if (toolNames.length > 0) {
      return {
        kind: "tools",
        preview: truncateRowSubtitle(`Calling ${toolNames.join(", ")}`),
      };
    }
  }
  return undefined;
}

/** Best-effort one-line preview of the user prompt for a prompt group's message range. */
function promptPreviewForRange(
  messages: TranscriptMessage[],
  startIndex?: number,
  endIndex?: number,
): string | undefined {
  const userMessageIndex = findUserMessageIndexForRange(
    messages,
    startIndex,
    endIndex,
  );
  if (typeof userMessageIndex !== "number") return undefined;
  const text = flattenTextFromMessage(messages[userMessageIndex]!);
  return text ? truncateRowSubtitle(text) : undefined;
}

/** Full (non-truncated) user prompt text for the detail pane. */
function fullUserPromptForRange(
  messages: TranscriptMessage[],
  startIndex?: number,
  endIndex?: number,
): string | undefined {
  const userMessageIndex = findUserMessageIndexForRange(
    messages,
    startIndex,
    endIndex,
  );
  if (typeof userMessageIndex !== "number") return undefined;
  const text = flattenTextFromMessage(messages[userMessageIndex]!);
  return text || undefined;
}

function partMatchesToolSpan(
  part: Record<string, unknown>,
  span: EvalTraceSpan,
): boolean {
  if (
    typeof span.toolCallId === "string" &&
    part.toolCallId === span.toolCallId
  ) {
    return true;
  }
  const spanToolName = span.toolName?.trim() || span.name?.trim();
  return Boolean(spanToolName && partToolName(part) === spanToolName);
}

function findToolFocusSourceIndex(
  messages: TranscriptMessage[],
  span: EvalTraceSpan,
  range: TranscriptRange | undefined,
): number | undefined {
  if (!range) return undefined;

  for (let index = range.startIndex; index <= range.endIndex; index += 1) {
    const message = messages[index];
    if (!message) continue;

    const parts = getMessageParts(message);
    const hasToolCall = parts.some(
      (part) => part.type === "tool-call" && partMatchesToolSpan(part, span),
    );
    if (hasToolCall) {
      return index;
    }

    const hasToolResult = parts.some(
      (part) => part.type === "tool-result" && partMatchesToolSpan(part, span),
    );
    if (hasToolResult) {
      return index;
    }
  }

  return undefined;
}

function getPromptRevealSelection(
  row: PromptRow,
  transcriptMessages: TranscriptMessage[],
): TraceRevealSelection | undefined {
  const userMessageIndex = findUserMessageIndexForRange(
    transcriptMessages,
    row.messageStartIndex,
    row.messageEndIndex,
  );
  if (typeof userMessageIndex === "number") {
    return {
      focusSourceIndex: userMessageIndex,
      highlightSourceIndices: [userMessageIndex],
    };
  }

  const transcriptRange = getPromptRowTranscriptRange(row);
  const highlightSourceIndices = getSourceIndicesForRange(transcriptRange);
  if (highlightSourceIndices.length === 0) {
    return undefined;
  }

  return {
    focusSourceIndex: highlightSourceIndices[0]!,
    highlightSourceIndices,
  };
}

function getSpanRevealSelection(
  row: SpanRow,
  transcriptMessages: TranscriptMessage[],
): TraceRevealSelection | undefined {
  const transcriptRange = getSpanRowTranscriptRange(row);
  const highlightSourceIndices = getSourceIndicesForRange(transcriptRange);
  if (highlightSourceIndices.length === 0) {
    return undefined;
  }

  const assistantMessageIndex = findMessageIndexInRange(
    transcriptMessages,
    transcriptRange,
    (message) => message.role === "assistant",
  );
  const toolFocusSourceIndex =
    row.span.category === "tool"
      ? findToolFocusSourceIndex(transcriptMessages, row.span, transcriptRange)
      : undefined;
  const focusSourceIndex =
    toolFocusSourceIndex ?? assistantMessageIndex ?? highlightSourceIndices[0]!;

  return {
    focusSourceIndex,
    highlightSourceIndices,
  };
}

function toolSubtitleFromTranscript(
  messages: TranscriptMessage[],
  span: EvalTraceSpan,
): string | undefined {
  const data = extractToolData(
    messages,
    span.toolCallId,
    span.toolName ?? span.name,
  );
  if (data.input == null) return undefined;
  const s = summarizeValue(data.input);
  if (!s || s === "None") return undefined;
  return truncateRowSubtitle(s);
}

function CategoryGlyph({
  category,
  size = "sm",
}: {
  category: EvalTraceSpanCategory | "prompt";
  size?: "sm" | "lg";
}) {
  const iconClass = cn(
    size === "lg" ? "h-5 w-5 shrink-0" : "h-3.5 w-3.5 shrink-0",
    getCategoryIconClass(category),
  );
  switch (category) {
    case "prompt":
      return <Layers className={iconClass} aria-hidden />;
    case "llm":
      return <Bot className={iconClass} aria-hidden />;
    case "tool":
      return <Wrench className={iconClass} aria-hidden />;
    case "error":
      return <AlertCircle className={iconClass} aria-hidden />;
    case "step":
    default:
      return <ListTree className={iconClass} aria-hidden />;
  }
}

function findStepLlmTokenStats(
  recordedSpans: EvalTraceSpan[],
  span: EvalTraceSpan,
): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const p = span.promptIndex;
  const s = span.stepIndex;
  if (typeof p !== "number" || typeof s !== "number") {
    return {};
  }
  const llm = recordedSpans.find(
    (sp) =>
      sp.category === "llm" && sp.promptIndex === p && sp.stepIndex === s,
  );
  if (!llm) {
    return {};
  }
  return {
    ...(typeof llm.inputTokens === "number"
      ? { inputTokens: llm.inputTokens }
      : {}),
    ...(typeof llm.outputTokens === "number"
      ? { outputTokens: llm.outputTokens }
      : {}),
    ...(typeof llm.totalTokens === "number"
      ? { totalTokens: llm.totalTokens }
      : {}),
  };
}

function getRowTokenStats(
  row: TimelineRow,
  recordedSpans?: EvalTraceSpan[] | null,
): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  if (row.kind === "prompt") {
    return {
      inputTokens: row.aggregatedInputTokens,
      outputTokens: row.aggregatedOutputTokens,
      totalTokens: row.aggregatedTotalTokens,
    };
  }
  const base = {
    inputTokens: row.span.inputTokens,
    outputTokens: row.span.outputTokens,
    totalTokens: row.span.totalTokens,
  };
  const hasAny =
    typeof base.inputTokens === "number" ||
    typeof base.outputTokens === "number" ||
    typeof base.totalTokens === "number";
  if (hasAny || !recordedSpans?.length) {
    return base;
  }
  const inherited = findStepLlmTokenStats(recordedSpans, row.span);
  if (
    typeof inherited.inputTokens === "number" ||
    typeof inherited.outputTokens === "number" ||
    typeof inherited.totalTokens === "number"
  ) {
    return inherited;
  }
  return base;
}

function formatTokenCount(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function formatWallClockTimestamp(timestampMs?: number | null): string {
  return typeof timestampMs === "number" && Number.isFinite(timestampMs)
    ? new Date(timestampMs).toLocaleString()
    : "—";
}

function getTraceStartAnchorMs({
  traceStartedAtMs,
  traceEndedAtMs,
  traceDurationMs,
}: {
  traceStartedAtMs?: number | null;
  traceEndedAtMs?: number | null;
  traceDurationMs: number;
}): number | null {
  if (
    typeof traceStartedAtMs === "number" &&
    Number.isFinite(traceStartedAtMs)
  ) {
    return traceStartedAtMs;
  }
  if (typeof traceEndedAtMs === "number" && Number.isFinite(traceEndedAtMs)) {
    return traceEndedAtMs - traceDurationMs;
  }
  return null;
}

function deriveSpanLabel(
  row: SpanRow,
  transcriptMessages: TranscriptMessage[],
): {
  title: string;
  subtitle?: string;
} {
  const { span, promptIndex } = row;
  const modelHint = span.modelId?.trim()
    ? truncateRowSubtitle(span.modelId.trim(), 56)
    : undefined;
  const rawName = span.name?.trim() ?? "";

  if (span.category === "step") {
    const stepNumber =
      typeof span.stepIndex === "number" ? span.stepIndex + 1 : undefined;
    const defaultTitle =
      typeof stepNumber === "number" ? `Step ${stepNumber}` : rawName || "Step";
    const genericName =
      typeof stepNumber === "number" &&
      (rawName === `Step ${stepNumber}` ||
        rawName.toLowerCase() === `step ${stepNumber}`);
    const title =
      rawName && !genericName ? truncateRowSubtitle(rawName, 64) : defaultTitle;
    const preview = promptPreviewForLlmSpan(transcriptMessages, span);
    if (preview) {
      return { title, subtitle: preview };
    }
    if (modelHint) {
      return { title, subtitle: modelHint };
    }
    return { title, subtitle: `Prompt ${promptIndex + 1}` };
  }

  if (span.category === "llm") {
    const assistantPreview = assistantPreviewForLlmSpan(
      transcriptMessages,
      span,
    );
    const genericLlmName =
      !rawName ||
      /^assistant$/i.test(rawName) ||
      /^llm$/i.test(rawName) ||
      /^model$/i.test(rawName) ||
      rawName === "Model response" ||
      /·\s*response$/i.test(rawName);
    const baseName = genericLlmName
      ? "Agent"
      : truncateRowSubtitle(rawName, 64);
    if (assistantPreview?.kind === "text") {
      return {
        title: `${baseName}: "${assistantPreview.preview}"`,
        subtitle: modelHint,
      };
    }
    if (assistantPreview?.kind === "tools") {
      return {
        title: `${baseName} · ${assistantPreview.preview}`,
        subtitle: modelHint,
      };
    }
    return { title: baseName, subtitle: modelHint };
  }

  if (span.category === "tool") {
    const name = (span.toolName ?? span.name).trim() || "tool";
    const title = `Tool · ${name}`;
    const toolSub = toolSubtitleFromTranscript(transcriptMessages, span);
    // Skip trivial subtitles like "{}" for empty tool inputs
    const isTrivialSub = !toolSub || toolSub === "{}" || toolSub === "None";
    if (toolSub && !isTrivialSub) {
      return { title, subtitle: toolSub };
    }
    // When input is empty/trivial, try to show output summary instead
    if (isTrivialSub) {
      const data = extractToolData(
        transcriptMessages,
        span.toolCallId,
        span.toolName ?? span.name,
      );
      if (data.output != null) {
        const outputPreview = summarizeValue(data.output);
        if (
          outputPreview &&
          outputPreview !== "None" &&
          outputPreview !== "{}"
        ) {
          return { title, subtitle: truncateRowSubtitle(outputPreview) };
        }
      }
    }
    if (typeof span.stepIndex === "number") {
      return {
        title,
        subtitle: modelHint
          ? `${modelHint} · step ${span.stepIndex + 1}`
          : `step ${span.stepIndex + 1}`,
      };
    }
    return {
      title,
      subtitle: modelHint,
    };
  }

  return {
    title: span.name,
    subtitle:
      typeof span.stepIndex === "number"
        ? modelHint
          ? `${modelHint} · step ${span.stepIndex + 1}`
          : `step ${span.stepIndex + 1}`
        : modelHint,
  };
}

function getRowTiming(row: TimelineRow): {
  startMs: number;
  endMs: number;
  durationMs: number;
} {
  const startMs = row.kind === "prompt" ? row.startMs : row.span.startMs;
  const endMs = row.kind === "prompt" ? row.endMs : row.span.endMs;
  return {
    startMs,
    endMs,
    durationMs: endMs - startMs,
  };
}

type PayloadVisualFormat = "plain" | "markdown";

function StringPayloadFormatToggles({
  format,
  onFormatChange,
}: {
  format: PayloadVisualFormat;
  onFormatChange: (next: PayloadVisualFormat) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {(["plain", "markdown"] as const).map((key) => (
        <Button
          key={key}
          type="button"
          size="sm"
          variant={format === key ? "secondary" : "outline"}
          className="h-7 text-[10px] capitalize"
          onClick={() => onFormatChange(key)}
        >
          {key === "plain" ? "Plain" : "Markdown"}
        </Button>
      ))}
    </div>
  );
}

function PayloadPreview({
  value,
  height = "180px",
}: {
  value: unknown;
  height?: string;
}) {
  const [format, setFormat] = useState<PayloadVisualFormat>("plain");

  useEffect(() => {
    if (typeof value === "string") {
      setFormat("plain");
    }
  }, [value]);

  if (value == null) {
    return (
      <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
        None
      </div>
    );
  }

  if (typeof value === "string") {
    const body =
      format === "markdown" ? (
        <div className="max-h-44 overflow-auto rounded-md border border-border/60 bg-muted/10 p-3 text-xs leading-relaxed text-foreground">
          <MemoizedMarkdown content={value} />
        </div>
      ) : (
        <pre className="max-h-44 overflow-auto rounded-md border border-border/60 bg-muted/20 p-3 text-xs whitespace-pre-wrap break-words">
          {value}
        </pre>
      );

    return (
      <div className="space-y-2">
        <StringPayloadFormatToggles
          format={format}
          onFormatChange={setFormat}
        />
        {body}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background">
      <JsonEditor height={height} viewOnly value={value} />
    </div>
  );
}

function TimelineDetailPane({
  row,
  transcriptMessages,
  onRevealInTranscript,
}: {
  row: TimelineRow | undefined;
  transcriptMessages: TranscriptMessage[];
  onRevealInTranscript?: (selection: TraceRevealSelection) => void;
}) {
  if (!row) {
    return (
      <div
        data-testid="trace-detail-pane"
        className="flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-lg bg-muted/5 px-6 py-12 text-center"
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border/50 bg-background shadow-sm">
          <Layers className="h-7 w-7 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            No span selected
          </p>
          <p className="text-xs text-muted-foreground">
            Click a row or use arrow keys
          </p>
        </div>
      </div>
    );
  }

  const revealSelection =
    row.kind === "prompt"
      ? getPromptRevealSelection(row, transcriptMessages)
      : getSpanRevealSelection(row, transcriptMessages);
  const toolData =
    row.kind === "span"
      ? extractToolData(
          transcriptMessages,
          row.span.toolCallId,
          row.span.toolName ?? row.span.name,
        )
      : {};
  const { durationMs } = getRowTiming(row);
  const spanLabel =
    row.kind === "span" ? deriveSpanLabel(row, transcriptMessages) : null;
  const title = row.kind === "prompt" ? row.label : spanLabel!.title;
  const status =
    row.kind === "prompt"
      ? row.hasAnyFailure
        ? "error"
        : "ok"
      : spanIndicatesTranscriptFailure(row.span, transcriptMessages)
        ? "error"
        : "ok";
  const detailGlyphCategory: EvalTraceSpanCategory | "prompt" =
    row.kind === "prompt"
      ? "prompt"
      : row.span.category === "tool" &&
          spanIndicatesTranscriptFailure(row.span, transcriptMessages)
        ? "error"
        : row.span.category;

  const llmIo =
    row.kind === "span" &&
    (row.span.category === "llm" || row.span.category === "step")
      ? extractLlmTranscriptIo(
          transcriptMessages,
          row.span.messageStartIndex,
          row.span.messageEndIndex,
        )
      : { input: null as unknown, output: null as unknown };

  const isToolIoSpan =
    row.kind === "span" &&
    row.span.category === "tool" &&
    (Boolean(row.span.toolCallId) ||
      Boolean(row.span.toolName?.trim() || row.span.name?.trim()));

  const tabInputValue =
    row.kind === "prompt"
      ? null
      : isToolIoSpan
        ? toolData.input
        : row.kind === "span" &&
            (row.span.category === "llm" || row.span.category === "step")
          ? llmIo.input
          : row.kind === "span" && row.span.category === "error"
            ? null
            : null;

  const tabOutputValue =
    row.kind === "prompt"
      ? null
      : isToolIoSpan
        ? toolData.output
        : row.kind === "span" &&
            (row.span.category === "llm" || row.span.category === "step")
          ? llmIo.output
          : row.kind === "span" && row.span.category === "error"
            ? row.span.name
            : null;

  // Extract the full user prompt text for the detail pane (not truncated)
  const promptUserMessage =
    row.kind === "prompt"
      ? fullUserPromptForRange(
          transcriptMessages,
          row.messageStartIndex,
          row.messageEndIndex,
        )
      : undefined;

  const hasSpanTokenStats =
    row.kind === "span" &&
    (typeof row.span.inputTokens === "number" ||
      typeof row.span.outputTokens === "number" ||
      typeof row.span.totalTokens === "number");

  const hasPromptTokenStats =
    row.kind === "prompt" &&
    (typeof row.aggregatedInputTokens === "number" ||
      typeof row.aggregatedOutputTokens === "number" ||
      typeof row.aggregatedTotalTokens === "number");

  const toolErrorExcerpt =
    row.kind === "span" && toolData.errorText ? toolData.errorText : null;

  return (
    <div
      data-testid="trace-detail-pane"
      className="space-y-4 bg-background p-4"
    >
      <div className="space-y-3 border-b border-border/40 pb-3">
        <div className="flex gap-3">
          <div className="shrink-0 pt-0.5">
            {row.kind === "prompt" ? (
              <CategoryGlyph category="prompt" size="lg" />
            ) : (
              <CategoryGlyph category={detailGlyphCategory} size="lg" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-sm font-bold leading-tight text-foreground">
                {title}
              </h3>
              {status === "error" ? (
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive"
                  title="Error"
                  aria-label="Error"
                />
              ) : null}
            </div>

            <div className="text-xs tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">
                {formatDuration(durationMs)}
              </span>
              {row.kind === "prompt" && hasPromptTokenStats ? (
                <>
                  {typeof row.aggregatedInputTokens === "number"
                    ? ` · ${row.aggregatedInputTokens} in`
                    : ""}
                  {typeof row.aggregatedOutputTokens === "number"
                    ? ` → ${row.aggregatedOutputTokens} out`
                    : ""}
                  {typeof row.aggregatedTotalTokens === "number"
                    ? ` (${row.aggregatedTotalTokens} total)`
                    : ""}
                </>
              ) : row.kind === "span" && hasSpanTokenStats ? (
                <>
                  {typeof row.span.inputTokens === "number"
                    ? ` · ${row.span.inputTokens} in`
                    : ""}
                  {typeof row.span.outputTokens === "number"
                    ? ` → ${row.span.outputTokens} out`
                    : ""}
                  {typeof row.span.totalTokens === "number"
                    ? ` (${row.span.totalTokens} total)`
                    : ""}
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {revealSelection && onRevealInTranscript ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-center"
          onClick={() => onRevealInTranscript(revealSelection)}
        >
          <MessageSquareQuote className="h-3.5 w-3.5" />
          Reveal in Chat
        </Button>
      ) : null}

      {row.kind === "prompt" && promptUserMessage ? (
        <div className="min-h-0 max-h-[min(60vh,28rem)] flex-1 overflow-auto rounded-md border border-border/50 bg-muted/10 px-3 py-2 text-xs leading-relaxed text-foreground">
          {promptUserMessage}
        </div>
      ) : null}

      {row.kind === "span" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Input
            </div>
            <PayloadPreview value={tabInputValue ?? undefined} height="220px" />
          </div>
          <div
            className={cn(
              "space-y-2",
              row.span.category === "error" || toolErrorExcerpt
                ? "rounded-md border border-red-500/25 bg-red-500/5 p-2"
                : "",
            )}
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Output
            </div>
            <PayloadPreview
              value={tabOutputValue ?? undefined}
              height="220px"
            />
            {toolErrorExcerpt ? (
              <pre className="max-h-40 overflow-auto rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs whitespace-pre-wrap break-words text-red-900 dark:text-red-100">
                {toolErrorExcerpt}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface TraceTimelineProps {
  recordedSpans?: EvalTraceSpan[] | null;
  estimatedDurationMs?: number | null;
  transcriptMessageCount?: number;
  transcriptMessages?: TranscriptMessage[];
  traceStartedAtMs?: number | null;
  traceEndedAtMs?: number | null;
  onRevealInTranscript?: (selection: TraceRevealSelection) => void;
  /** When true, timeline does not render the recorded toolbar (host provides it). */
  hideToolbar?: boolean;
  timelineFilter?: TimelineFilter;
  onTimelineFilterChange?: (filter: TimelineFilter) => void;
  expandedPromptIds?: Set<string>;
  onExpandedPromptIdsChange?: (next: Set<string>) => void;
  expandedStepIds?: Set<string>;
  onExpandedStepIdsChange?: (next: Set<string>) => void;
  /** Timeline axis ends at this many ms (≥ max span end); used for zoom. */
  viewportMaxMs?: number;
  /** When true, timeline fills a flex parent (e.g. run detail) instead of using viewport-based max height alone. */
  fillContent?: boolean;
}

export function TraceTimeline({
  recordedSpans,
  estimatedDurationMs,
  transcriptMessageCount = 0,
  transcriptMessages = [],
  traceStartedAtMs = null,
  traceEndedAtMs = null,
  onRevealInTranscript,
  hideToolbar = false,
  timelineFilter: timelineFilterProp,
  onTimelineFilterChange,
  expandedPromptIds: expandedPromptIdsProp,
  onExpandedPromptIdsChange,
  expandedStepIds: expandedStepIdsProp,
  onExpandedStepIdsChange,
  viewportMaxMs: viewportMaxMsProp,
  fillContent = false,
}: TraceTimelineProps) {
  const shouldReduceMotion = useReducedMotion();
  const mode =
    recordedSpans && recordedSpans.length > 0
      ? "recorded"
      : (estimatedDurationMs ?? 0) > 0
        ? "estimated"
        : "none";
  const groups = useMemo(
    () => (recordedSpans?.length ? buildPromptGroups(recordedSpans) : []),
    [recordedSpans],
  );
  const maxEndMs = recordedSpans?.length
    ? recordedSpans.reduce((max, span) => Math.max(max, span.endMs), 1)
    : Math.max(estimatedDurationMs ?? 0, 1);
  const traceIdentity = useMemo(
    () =>
      recordedSpans
        ?.map((span) => `${span.id}:${span.startMs}:${span.endMs}`)
        .join("|") ?? mode,
    [mode, recordedSpans],
  );

  const [internalViewportMaxMs, setInternalViewportMaxMs] = useState(1);
  useEffect(() => {
    if (viewportMaxMsProp === undefined) {
      setInternalViewportMaxMs(maxEndMs);
    }
  }, [maxEndMs, traceIdentity, viewportMaxMsProp]);

  const axisMaxMs = Math.max(
    1,
    viewportMaxMsProp !== undefined ? viewportMaxMsProp : internalViewportMaxMs,
  );

  const timelineZoomMinMs = Math.max(1, Math.round(maxEndMs / 50));
  const traceStartAnchorMs = useMemo(
    () =>
      getTraceStartAnchorMs({
        traceStartedAtMs,
        traceEndedAtMs,
        traceDurationMs: maxEndMs,
      }),
    [maxEndMs, traceEndedAtMs, traceStartedAtMs],
  );

  const [internalFilter, setInternalFilter] = useState<TimelineFilter>("all");
  const filter =
    timelineFilterProp !== undefined ? timelineFilterProp : internalFilter;
  const setFilter = onTimelineFilterChange ?? setInternalFilter;

  const [internalExpandedPromptIds, setInternalExpandedPromptIds] = useState<
    Set<string>
  >(new Set());
  const [internalExpandedStepIds, setInternalExpandedStepIds] = useState<
    Set<string>
  >(new Set());
  const expandedPromptIds =
    expandedPromptIdsProp !== undefined
      ? expandedPromptIdsProp
      : internalExpandedPromptIds;
  const setExpandedPromptIds =
    onExpandedPromptIdsChange ?? setInternalExpandedPromptIds;
  const expandedStepIds =
    expandedStepIdsProp !== undefined
      ? expandedStepIdsProp
      : internalExpandedStepIds;
  const setExpandedStepIds =
    onExpandedStepIdsChange ?? setInternalExpandedStepIds;

  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

  const axisHeaderMeasureRef = useRef<HTMLDivElement>(null);
  const [axisColumnWidthPx, setAxisColumnWidthPx] = useState(-1);

  useLayoutEffect(() => {
    const el = axisHeaderMeasureRef.current;
    if (!el) return;

    const readWidth = () => {
      const w = el.getBoundingClientRect().width;
      setAxisColumnWidthPx(Number.isFinite(w) ? w : 0);
    };
    readWidth();

    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(readWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const axisTicks = useMemo(
    () => selectAxisTickPercents(axisColumnWidthPx),
    [axisColumnWidthPx],
  );

  const collapseAxisToSingleRangeLabel = useMemo(() => {
    if (axisTicks.length !== 2) {
      return false;
    }
    if (axisColumnWidthPx < 0) {
      return true;
    }
    if (axisColumnWidthPx === 0) {
      return true;
    }
    return axisColumnWidthPx < AXIS_SINGLE_RANGE_LABEL_BELOW_PX;
  }, [axisColumnWidthPx, axisTicks]);

  useEffect(() => {
    if (!hideToolbar) {
      setInternalExpandedPromptIds(new Set(groups.map((group) => group.key)));
      setInternalExpandedStepIds(collectStepSpanIdsWithChildren(groups));
    }
  }, [hideToolbar, groups]);

  const rows = useMemo(() => {
    if (mode !== "recorded") {
      return [] as TimelineRow[];
    }

    const nextRows: TimelineRow[] = [];

    function rowSelfVisible(span: EvalTraceSpan): boolean {
      if (filter === "all") return true;
      if (filter === "error") {
        return spanIndicatesTranscriptFailure(span, transcriptMessages);
      }
      return span.category === filter;
    }

    function collectNodeRows(
      node: TraceNode,
      promptIndex: number,
      depth: number,
    ): {
      hasVisibleContent: boolean;
      rows: TimelineRow[];
    } {
      const isStep = node.span.category === "step";
      // Steps are hidden — their children inherit the step's depth level
      const childDepth = isStep ? depth : depth + 1;
      const childResults = node.children.map((child) =>
        collectNodeRows(child, promptIndex, childDepth),
      );
      const visibleChildRows = childResults.flatMap((result) => result.rows);
      const hasVisibleChildren = childResults.some(
        (result) => result.hasVisibleContent,
      );

      // Skip step rows entirely — just show their children promoted up
      if (isStep) {
        return {
          hasVisibleContent: hasVisibleChildren || node.children.length > 0,
          rows: visibleChildRows,
        };
      }

      // Skip overhead LLM spans (framework routing/dispatch, no actual generation)
      const isOverheadLlm =
        node.span.category === "llm" &&
        typeof node.span.totalTokens !== "number" &&
        typeof node.span.inputTokens !== "number" &&
        typeof node.span.outputTokens !== "number" &&
        node.span.endMs - node.span.startMs < 50;
      if (isOverheadLlm) {
        return { hasVisibleContent: false, rows: [] };
      }

      const showSelf = rowSelfVisible(node.span) || hasVisibleChildren;

      if (!showSelf) {
        return {
          hasVisibleContent: hasVisibleChildren,
          rows: visibleChildRows,
        };
      }

      const row: SpanRow = {
        kind: "span",
        key: node.span.id,
        promptIndex,
        depth,
        span: node.span,
        hasChildren: node.children.length > 0,
        isExpanded: expandedStepIds.has(node.span.id),
      };

      return {
        hasVisibleContent: true,
        rows: [
          row,
          ...(row.hasChildren && row.isExpanded ? visibleChildRows : []),
        ],
      };
    }

    for (const group of groups) {
      const rootResults = group.roots.map((root) =>
        collectNodeRows(root, group.promptIndex, 0),
      );
      const childRows = rootResults.flatMap((result) => result.rows);
      const hasVisibleContent =
        childRows.length > 0 || (filter === "all" && group.spans.length > 0);

      if (!hasVisibleContent) {
        continue;
      }

      const hasAnyFailure = group.spans.some((span) =>
        spanIndicatesTranscriptFailure(span, transcriptMessages),
      );

      const userPreview = promptPreviewForRange(
        transcriptMessages,
        group.messageStartIndex,
        group.messageEndIndex,
      );

      const aggTokens = aggregateLlmTokenTotals(group.spans);

      nextRows.push({
        kind: "prompt",
        key: group.key,
        promptIndex: group.promptIndex,
        label: group.label,
        conversationLabel: userPreview ? `User: "${userPreview}"` : undefined,
        startMs: group.startMs,
        endMs: group.endMs,
        messageStartIndex: group.messageStartIndex,
        messageEndIndex: group.messageEndIndex,
        counts: group.counts,
        hasAnyFailure,
        isExpanded: expandedPromptIds.has(group.key),
        aggregatedInputTokens: aggTokens.inputTokens,
        aggregatedOutputTokens: aggTokens.outputTokens,
        aggregatedTotalTokens: aggTokens.totalTokens,
      });

      if (expandedPromptIds.has(group.key)) {
        nextRows.push(...childRows);
      }
    }

    return nextRows;
  }, [
    expandedPromptIds,
    expandedStepIds,
    filter,
    groups,
    mode,
    transcriptMessages,
  ]);

  const fullyExpandedStepIds = useMemo(
    () => collectStepSpanIdsWithChildren(groups),
    [groups],
  );
  const isFullyExpanded = useMemo(() => {
    if (groups.length === 0) return false;
    for (const group of groups) {
      if (!expandedPromptIds.has(group.key)) return false;
    }
    for (const id of fullyExpandedStepIds) {
      if (!expandedStepIds.has(id)) return false;
    }
    return true;
  }, [groups, expandedPromptIds, expandedStepIds, fullyExpandedStepIds]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedRowKey(null);
      return;
    }
    if (!selectedRowKey || !rows.some((row) => row.key === selectedRowKey)) {
      setSelectedRowKey(rows[0]!.key);
    }
  }, [rows, selectedRowKey]);

  const selectedRow = rows.find((row) => row.key === selectedRowKey);

  const handleWaterfallKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const idx = rows.findIndex((r) => r.key === selectedRowKey);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
        setSelectedRowKey(rows[next]!.key);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = idx <= 0 ? 0 : idx - 1;
        setSelectedRowKey(rows[next]!.key);
        return;
      }
      if (event.key === "Enter" && idx >= 0) {
        const r = rows[idx]!;
        if (r.kind === "prompt") {
          event.preventDefault();
          const next = new Set(expandedPromptIds);
          if (next.has(r.key)) next.delete(r.key);
          else next.add(r.key);
          setExpandedPromptIds(next);
          return;
        }
        if (r.kind === "span" && r.hasChildren) {
          event.preventDefault();
          const next = new Set(expandedStepIds);
          if (next.has(r.key)) next.delete(r.key);
          else next.add(r.key);
          setExpandedStepIds(next);
        }
      }
    },
    [
      expandedPromptIds,
      expandedStepIds,
      rows,
      selectedRowKey,
      setExpandedPromptIds,
      setExpandedStepIds,
    ],
  );

  if (mode === "none") {
    return (
      <div className="text-xs text-muted-foreground">
        No timing data recorded for this iteration.
      </div>
    );
  }

  if (mode === "estimated") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
            Estimated total only
          </Badge>
          <span className="text-xs text-muted-foreground">
            {formatDuration(estimatedDurationMs ?? 0)}
          </span>
        </div>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>Per-step timing was not recorded for this run.</p>
          {transcriptMessageCount > 0 ? (
            <p>
              Conversation detail is in the Chat tab. Open{" "}
              <span className="font-medium text-foreground/80">Raw</span> to
              inspect the stored trace and confirm whether a{" "}
              <code className="rounded border border-border/50 bg-muted/40 px-1 py-px font-mono text-[10px] text-foreground/90">
                spans
              </code>{" "}
              array exists; only new runs that persist spans show a per-step
              timeline here.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const internalZoomCluster =
    viewportMaxMsProp === undefined ? (
      <>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7 border-border/50"
          title="Zoom in timeline"
          aria-label="Zoom in timeline"
          disabled={internalViewportMaxMs <= timelineZoomMinMs}
          onClick={() =>
            setInternalViewportMaxMs((v) =>
              Math.max(timelineZoomMinMs, Math.round(v * 0.8)),
            )
          }
        >
          <Plus className="size-3.5" aria-hidden />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7 border-border/50"
          title="Zoom out timeline"
          aria-label="Zoom out timeline"
          disabled={internalViewportMaxMs >= maxEndMs * 4}
          onClick={() =>
            setInternalViewportMaxMs((v) =>
              Math.min(maxEndMs * 4, Math.round(v * 1.25)),
            )
          }
        >
          <Minus className="size-3.5" aria-hidden />
        </Button>
      </>
    ) : null;

  return (
    <div
      className={cn("space-y-2", fillContent && "flex min-h-0 flex-1 flex-col")}
    >
      {!hideToolbar ? (
        <div className={fillContent ? "shrink-0" : undefined}>
          <RecordedTraceToolbar
            filter={filter}
            onFilterChange={setFilter}
            isFullyExpanded={isFullyExpanded}
            expandDisabled={groups.length === 0}
            zoomControls={internalZoomCluster}
            onToggleExpandAll={() => {
              if (isFullyExpanded) {
                setExpandedPromptIds(new Set());
                setExpandedStepIds(new Set());
              } else {
                setExpandedPromptIds(new Set(groups.map((group) => group.key)));
                setExpandedStepIds(new Set(fullyExpandedStepIds));
              }
            }}
          />
        </div>
      ) : null}

      <div
        className={cn(
          "@container/trace-timeline min-w-0",
          fillContent && "flex min-h-0 flex-1 flex-col",
        )}
      >
        <ResizablePanelGroup
          direction="horizontal"
          className={cn(
            "rounded-lg border border-border/50 bg-background",
            fillContent
              ? "min-h-0 flex-1 overflow-hidden"
              : "min-h-[min(25rem,calc(100dvh-8rem))]",
          )}
          style={fillContent ? undefined : { height: "auto" }}
        >
          <ResizablePanel
            defaultSize={65}
            minSize={40}
            className="min-h-0 min-w-0 overflow-hidden"
          >
            <ScrollArea
              className={cn(
                fillContent
                  ? "h-full min-h-0 overflow-hidden"
                  : "max-h-[calc(100vh-8rem)] min-h-0",
              )}
            >
              <div
                tabIndex={0}
                role="region"
                aria-label="Trace timeline. Use arrow keys to change selection, Enter to expand."
                onKeyDown={handleWaterfallKeyDown}
                className="min-h-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div
                  className="grid pr-4"
                  style={{
                    gridTemplateColumns:
                      "minmax(140px, 260px) minmax(0, 1fr) minmax(5.25rem, max-content)",
                    gridTemplateRows: `auto repeat(${rows.length}, minmax(48px, auto))`,
                  }}
                >
                  <div
                    className="sticky top-0 z-20 border-b border-border/50 bg-background/95 px-4 py-1.5 backdrop-blur"
                    style={{ gridColumn: "1 / 3", gridRow: 1 }}
                  >
                    <div className="flex min-h-6 min-w-0 items-center gap-3">
                      <div className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Timeline
                      </div>
                      <div className="min-h-6 min-w-0 flex-1">
                        <div
                          ref={axisHeaderMeasureRef}
                          className="relative h-6 min-w-0"
                        >
                          {collapseAxisToSingleRangeLabel ? (
                            <div className="flex h-full min-w-0 items-center justify-center">
                              <span
                                className="min-w-0 max-w-full truncate text-center text-[10px] tabular-nums text-muted-foreground"
                                title={formatAxisRangeLabel(axisMaxMs)}
                              >
                                {formatAxisRangeLabel(axisMaxMs)}
                              </span>
                            </div>
                          ) : (
                            axisTicks.map((tick) => {
                              const left = tick >= 100 ? "100%" : `${tick}%`;
                              return (
                                <div
                                  key={tick}
                                  className="pointer-events-none absolute inset-y-0"
                                  style={{ left }}
                                >
                                  <div
                                    className={cn(
                                      "absolute text-[10px] tabular-nums text-muted-foreground",
                                      axisTickLabelAlignClass(tick),
                                    )}
                                  >
                                    {formatAxisLabel((axisMaxMs * tick) / 100)}
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div
                    className="sticky top-0 z-20 flex min-h-0 items-center border-b border-l border-border/50 bg-background/95 px-3 py-1.5 pl-4 backdrop-blur"
                    style={{ gridColumn: 3, gridRow: 1 }}
                  >
                    <div className="flex h-6 w-full min-w-0 items-center justify-start gap-1.5">
                      <Clock
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Latency
                      </span>
                    </div>
                  </div>

                  {rows.length > 0 ? (
                    <div
                      className="pointer-events-none relative z-0 bg-transparent"
                      style={{
                        gridColumn: 2,
                        gridRow: `2 / ${rows.length + 2}`,
                      }}
                    >
                      {axisTicks.map((tick) => (
                        <div
                          key={tick}
                          className="absolute top-0 bottom-0 w-px bg-border/40"
                          style={{
                            left: tick >= 100 ? "100%" : `${tick}%`,
                          }}
                        />
                      ))}
                    </div>
                  ) : null}

                  {rows.map((row, rowIndex) => {
                    const isSelected = row.key === selectedRowKey;
                    const { startMs, endMs, durationMs } = getRowTiming(row);
                    const leftPercent = (startMs / axisMaxMs) * 100;
                    const widthPercent = Math.max(
                      ((endMs - startMs) / axisMaxMs) * 100,
                      0.45,
                    );
                    const spanShowsFailure =
                      row.kind === "span" &&
                      spanIndicatesTranscriptFailure(
                        row.span,
                        transcriptMessages,
                      );
                    const rowGlyphCategory: EvalTraceSpanCategory | "prompt" =
                      row.kind === "prompt"
                        ? "prompt"
                        : row.span.category === "tool" && spanShowsFailure
                          ? "error"
                          : row.span.category;
                    const derivedLabel =
                      row.kind === "span"
                        ? deriveSpanLabel(row, transcriptMessages)
                        : null;
                    const label =
                      row.kind === "prompt"
                        ? (row.conversationLabel ?? row.label)
                        : derivedLabel!.title;
                    const durationLabel = formatDuration(durationMs);
                    const tokenStats = getRowTokenStats(row, recordedSpans);
                    const rowStartTimestamp =
                      traceStartAnchorMs !== null
                        ? traceStartAnchorMs + startMs
                        : null;
                    const rowEndTimestamp =
                      traceStartAnchorMs !== null
                        ? traceStartAnchorMs + endMs
                        : null;
                    const canToggle =
                      row.kind === "prompt" ? true : row.hasChildren;
                    const gridRow = rowIndex + 2;
                    const borderAccent = getRowBorderAccentClass(
                      row,
                      spanShowsFailure,
                    );
                    const waterfallBarClass = getWaterfallBarClass(
                      row,
                      spanShowsFailure,
                    );
                    const selectRow = () => setSelectedRowKey(row.key);
                    const leftCellClass = isSelected
                      ? cn("bg-transparent", borderAccent)
                      : "border-l-transparent bg-background group-hover:bg-muted/20 hover:bg-muted/20";
                    const sharedCellClass = isSelected
                      ? "bg-transparent"
                      : "bg-background group-hover:bg-muted/20 hover:bg-muted/20";

                    return (
                      <HoverCard key={row.key} openDelay={0} closeDelay={0}>
                        <HoverCardTrigger asChild>
                          <motion.div
                            data-testid="trace-row"
                            data-state={isSelected ? "selected" : undefined}
                            initial={
                              shouldReduceMotion || rowIndex >= 20
                                ? false
                                : { opacity: 0, y: 6 }
                            }
                            animate={{ opacity: 1, y: 0 }}
                            transition={
                              shouldReduceMotion || rowIndex >= 20
                                ? { duration: 0 }
                                : {
                                    duration: 0.15,
                                    delay: rowIndex * 0.03 + 0.05,
                                    ease: [0.16, 1, 0.3, 1],
                                  }
                            }
                            style={{
                              gridColumn: "1 / 4",
                              gridRow,
                              display: "grid",
                              gridTemplateColumns: "subgrid",
                            }}
                            className={cn(
                              "group min-h-0 min-w-0 items-stretch",
                              isSelected &&
                                "trace-waterfall-row-selected ring-1 ring-inset ring-ring/40",
                            )}
                          >
                            <div
                              className={cn(
                                "flex items-center gap-2 border-b border-border/40 px-4 py-2 transition-all duration-150 border-l-2",
                                leftCellClass,
                              )}
                            >
                              <div
                                className="flex shrink-0 items-center"
                                style={{
                                  paddingLeft:
                                    row.kind === "prompt" ? 0 : row.depth * 16,
                                }}
                              >
                                {canToggle ? (
                                  <button
                                    type="button"
                                    className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (row.kind === "prompt") {
                                        const next = new Set(expandedPromptIds);
                                        if (next.has(row.key))
                                          next.delete(row.key);
                                        else next.add(row.key);
                                        setExpandedPromptIds(next);
                                        return;
                                      }
                                      const next = new Set(expandedStepIds);
                                      if (next.has(row.key))
                                        next.delete(row.key);
                                      else next.add(row.key);
                                      setExpandedStepIds(next);
                                    }}
                                    aria-label={
                                      row.kind === "prompt"
                                        ? `${row.isExpanded ? "Collapse" : "Expand"} ${row.label}`
                                        : `${row.isExpanded ? "Collapse" : "Expand"} ${label}`
                                    }
                                  >
                                    {row.isExpanded ? (
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                ) : (
                                  <span className="mr-1 h-5 w-5" />
                                )}
                              </div>
                              <button
                                type="button"
                                data-testid="trace-row-label-button"
                                className="min-w-0 flex-1 text-left"
                                onClick={selectRow}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  {row.kind === "prompt" ? (
                                    <CategoryGlyph category="prompt" />
                                  ) : (
                                    <CategoryGlyph
                                      category={rowGlyphCategory}
                                    />
                                  )}
                                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                    {label}
                                  </span>
                                  {row.kind === "prompt" &&
                                  row.hasAnyFailure ? (
                                    <span
                                      className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive"
                                      title="Contains errors"
                                      aria-label="Contains errors"
                                    />
                                  ) : null}
                                  {row.kind === "span" && spanShowsFailure ? (
                                    <span
                                      className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive"
                                      title="Error"
                                      aria-label="Error"
                                    />
                                  ) : null}
                                </div>
                              </button>
                            </div>
                            <button
                              type="button"
                              data-testid="trace-row-bar-hit"
                              data-state={isSelected ? "selected" : undefined}
                              className={cn(
                                "relative z-[1] flex min-h-[48px] w-full items-center overflow-hidden border-b border-border/40 border-l-2 border-l-transparent px-4 py-2 text-left transition-all duration-150",
                                sharedCellClass,
                              )}
                              aria-label={`Select on timeline (${formatDuration(durationMs)})`}
                              onClick={selectRow}
                            >
                              <div
                                data-testid={
                                  row.kind === "span" && spanShowsFailure
                                    ? "trace-row-bar-error"
                                    : "trace-row-bar"
                                }
                                className={cn(
                                  "absolute top-1/2 z-[1] h-4 min-w-0 -translate-y-1/2 rounded-[3px] transition-[left,width] duration-150",
                                  waterfallBarClass,
                                )}
                                style={{
                                  left: `${leftPercent}%`,
                                  width: `max(${widthPercent}%, 3px)`,
                                }}
                              />
                            </button>
                            <button
                              type="button"
                              data-testid="trace-row-duration-hit"
                              data-state={isSelected ? "selected" : undefined}
                              className={cn(
                                "flex min-h-[48px] items-center justify-start gap-1.5 whitespace-nowrap border-b border-l border-border/40 px-3 py-2 pl-4 text-[11px] tabular-nums text-muted-foreground transition-all duration-150",
                                sharedCellClass,
                              )}
                              aria-label={`Select row duration (${durationLabel})`}
                              onClick={selectRow}
                            >
                              <Clock
                                className="size-3 shrink-0 opacity-80"
                                aria-hidden
                              />
                              {durationLabel}
                            </button>
                          </motion.div>
                        </HoverCardTrigger>
                        <HoverCardContent
                          data-testid="trace-row-hover-content"
                          align="start"
                          side="left"
                          className="w-72 space-y-3 p-3"
                        >
                          <div
                            data-testid="trace-row-hover-card"
                            className="space-y-3"
                          >
                            <div className="space-y-1.5">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Time
                              </div>
                              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                                <dt className="text-muted-foreground">Start</dt>
                                <dd
                                  data-testid="trace-row-hover-start"
                                  className="text-right font-medium text-foreground"
                                >
                                  {formatWallClockTimestamp(rowStartTimestamp)}
                                </dd>
                                <dt className="text-muted-foreground">End</dt>
                                <dd
                                  data-testid="trace-row-hover-end"
                                  className="text-right font-medium text-foreground"
                                >
                                  {formatWallClockTimestamp(rowEndTimestamp)}
                                </dd>
                              </dl>
                            </div>
                            <div className="space-y-1.5">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Tokens
                              </div>
                              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                                <dt className="text-muted-foreground">Input</dt>
                                <dd
                                  data-testid="trace-row-hover-input-tokens"
                                  className="text-right font-medium tabular-nums text-foreground"
                                >
                                  {formatTokenCount(tokenStats.inputTokens)}
                                </dd>
                                <dt className="text-muted-foreground">
                                  Output
                                </dt>
                                <dd
                                  data-testid="trace-row-hover-output-tokens"
                                  className="text-right font-medium tabular-nums text-foreground"
                                >
                                  {formatTokenCount(tokenStats.outputTokens)}
                                </dd>
                                <dt className="text-muted-foreground">Total</dt>
                                <dd
                                  data-testid="trace-row-hover-total-tokens"
                                  className="text-right font-medium tabular-nums text-foreground"
                                >
                                  {formatTokenCount(tokenStats.totalTokens)}
                                </dd>
                              </dl>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    );
                  })}
                </div>
              </div>
            </ScrollArea>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            defaultSize={35}
            minSize={20}
            maxSize={50}
            className="min-h-0 min-w-0 overflow-hidden"
          >
            <div
              data-testid="trace-timeline-detail-sticky"
              className={cn(
                "min-h-0 min-w-0 overflow-y-auto lg:sticky lg:top-3",
                fillContent
                  ? "max-h-full lg:max-h-full"
                  : "lg:max-h-[calc(100vh-8rem)]",
              )}
            >
              <TimelineDetailPane
                row={selectedRow}
                transcriptMessages={transcriptMessages}
                onRevealInTranscript={onRevealInTranscript}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
