import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronRight,
  Expand,
  Layers,
  ListTree,
  MessageSquareQuote,
  Shrink,
  Wrench,
} from "lucide-react";
import type { EvalTraceSpan, EvalTraceSpanCategory } from "@/shared/eval-trace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "@/components/ui/json-editor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { extractTextFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import { cn } from "@/lib/utils";

const LABEL_W = 320;
const TIMELINE_W = 780;
const TICKS = [0, 25, 50, 75, 100];
const FILTERS = ["all", "llm", "tool", "error"] as const;

type TimelineFilter = (typeof FILTERS)[number];

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
  startMs: number;
  endMs: number;
  messageStartIndex?: number;
  messageEndIndex?: number;
  counts: Record<EvalTraceSpanCategory, number>;
  /** Includes transcript-derived tool failures, not only category:error spans. */
  hasAnyFailure: boolean;
  isExpanded: boolean;
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

type TranscriptRange = {
  startIndex: number;
  endIndex: number;
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

function formatOffset(ms: number): string {
  return `+${formatAxisLabel(ms)}`;
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

function getCategoryClasses(category: EvalTraceSpanCategory): {
  bar: string;
  rail: string;
} {
  switch (category) {
    case "step":
      return {
        bar: "bg-slate-500/85",
        rail: "bg-slate-500/10",
      };
    case "llm":
      return {
        bar: "bg-blue-500/85",
        rail: "bg-blue-500/10",
      };
    case "tool":
      return {
        bar: "bg-amber-500/85",
        rail: "bg-amber-500/10",
      };
    case "error":
      return {
        bar: "bg-red-500/85",
        rail: "bg-red-500/10",
      };
    default:
      return {
        bar: "bg-muted-foreground/60",
        rail: "bg-muted/40",
      };
  }
}

function buildPromptGroups(spans: EvalTraceSpan[]): PromptGroup[] {
  const spansByPrompt = new Map<number, EvalTraceSpan[]>();
  for (const span of spans) {
    const promptIndex =
      typeof span.promptIndex === "number" ? span.promptIndex : 0;
    spansByPrompt.set(promptIndex, [
      ...(spansByPrompt.get(promptIndex) ?? []),
      span,
    ]);
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

      const counts = {
        step: promptSpans.filter((span) => span.category === "step").length,
        llm: promptSpans.filter((span) => span.category === "llm").length,
        tool: promptSpans.filter((span) => span.category === "tool").length,
        error: promptSpans.filter((span) => span.category === "error").length,
      } satisfies Record<EvalTraceSpanCategory, number>;

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

function collectStepSpanIdsWithChildren(groups: PromptGroup[]): Set<string> {
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
 * Messages the model sees before its assistant reply within this span's transcript range
 * (user, system, tool results, …). If there is no assistant in-range, returns the full slice.
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

  let lastAssistant = -1;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    if (slice[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }

  if (lastAssistant < 0) return slice;
  const inputSlice = slice.slice(0, lastAssistant);
  if (inputSlice.length === 0 && lastAssistant === 0 && range.startIndex > 0) {
    const prev = messages[range.startIndex - 1];
    if (prev?.role === "user" || prev?.role === "system") {
      return [prev];
    }
  }
  return inputSlice;
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
}: {
  category: EvalTraceSpanCategory | "prompt";
}) {
  const iconClass = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  switch (category) {
    case "prompt":
      return <Layers className={iconClass} aria-hidden />;
    case "llm":
      return <Brain className={iconClass} aria-hidden />;
    case "tool":
      return <Wrench className={iconClass} aria-hidden />;
    case "error":
      return <AlertCircle className={iconClass} aria-hidden />;
    case "step":
    default:
      return <ListTree className={iconClass} aria-hidden />;
  }
}

function formatInlineTokenHint(span: EvalTraceSpan): string | null {
  if (span.category !== "llm") return null;
  if (typeof span.totalTokens === "number") {
    return `${span.totalTokens} tok`;
  }
  if (
    typeof span.inputTokens === "number" ||
    typeof span.outputTokens === "number"
  ) {
    const a = typeof span.inputTokens === "number" ? span.inputTokens : "—";
    const b = typeof span.outputTokens === "number" ? span.outputTokens : "—";
    return `${a}→${b} tok`;
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

  if (span.category === "step") {
    const stepNumber =
      typeof span.stepIndex === "number" ? span.stepIndex + 1 : span.name;
    const title =
      typeof stepNumber === "number" ? `Step ${stepNumber}` : String(span.name);
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
    const preview = promptPreviewForLlmSpan(transcriptMessages, span);
    if (preview) {
      return {
        title: "Model response",
        subtitle: modelHint ? `${preview} · ${modelHint}` : preview,
      };
    }
    return {
      title: "Model response",
      subtitle: modelHint ?? `Prompt ${promptIndex + 1}`,
    };
  }

  if (span.category === "tool") {
    const name = (span.toolName ?? span.name).trim() || "tool";
    const title = `Tool · ${name}`;
    const toolSub = toolSubtitleFromTranscript(transcriptMessages, span);
    if (toolSub) {
      return { title, subtitle: toolSub };
    }
    if (typeof span.stepIndex === "number") {
      return {
        title,
        subtitle: modelHint
          ? `${modelHint} · step ${span.stepIndex + 1}`
          : `Step ${span.stepIndex + 1}`,
      };
    }
    return {
      title,
      subtitle: modelHint ?? `Prompt ${promptIndex + 1}`,
    };
  }

  return {
    title: span.name,
    subtitle:
      typeof span.stepIndex === "number"
        ? `Prompt ${promptIndex + 1} · Step ${span.stepIndex + 1}`
        : `Prompt ${promptIndex + 1}`,
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

function PayloadPreview({
  value,
  height = "180px",
}: {
  value: unknown;
  height?: string;
}) {
  if (value == null) {
    return (
      <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
        None
      </div>
    );
  }

  if (typeof value === "string") {
    return (
      <pre className="max-h-44 overflow-auto rounded-md border border-border/60 bg-muted/20 p-3 text-xs whitespace-pre-wrap break-words">
        {value}
      </pre>
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
  onRevealInTranscript?: (range: TranscriptRange) => void;
}) {
  if (!row) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/10 p-4 text-xs text-muted-foreground">
        Select a prompt, step, or child row to inspect timing and transcript
        context.
      </div>
    );
  }

  const transcriptRange =
    row.kind === "prompt"
      ? getPromptRowTranscriptRange(row)
      : getSpanRowTranscriptRange(row);
  const transcriptPreview = transcriptRange
    ? transcriptMessages
        .slice(transcriptRange.startIndex, transcriptRange.endIndex + 1)
        .map((message, offset) => ({
          index: transcriptRange.startIndex + offset,
          role: message.role,
          summary: formatMessageSummary(message),
        }))
        .slice(0, 4)
    : [];
  const toolData =
    row.kind === "span"
      ? extractToolData(
          transcriptMessages,
          row.span.toolCallId,
          row.span.toolName ?? row.span.name,
        )
      : {};
  const promptIndex = row.kind === "prompt" ? row.promptIndex : row.promptIndex;
  const { startMs, endMs, durationMs } = getRowTiming(row);
  const label =
    row.kind === "prompt"
      ? row.label
      : deriveSpanLabel(row, transcriptMessages).title;
  const subtitle =
    row.kind === "prompt"
      ? formatOffset(row.startMs)
      : deriveSpanLabel(row, transcriptMessages).subtitle;
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

  const showIoTabs = row.kind === "span";

  return (
    <div
      data-testid="trace-detail-pane"
      className="space-y-4 rounded-lg border border-border/50 bg-background p-4"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {row.kind === "prompt" ? (
            <CategoryGlyph category="prompt" />
          ) : (
            <CategoryGlyph category={detailGlyphCategory} />
          )}
          {status === "error" ? (
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full bg-destructive"
              title="Error"
              aria-label="Error"
            />
          ) : null}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{label}</h3>
          {subtitle ? (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3 text-xs">
        <div className="rounded-md border border-border/50 bg-muted/10 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Duration
          </div>
          <div className="mt-1 font-medium text-foreground">
            {formatDuration(durationMs)}
          </div>
          <div className="mt-1 text-muted-foreground">
            {formatOffset(startMs)} to {formatOffset(endMs)}
          </div>
        </div>
        <div className="rounded-md border border-border/50 bg-muted/10 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Transcript indices
          </div>
          <div className="mt-1 font-medium text-foreground">
            {transcriptRange
              ? `${transcriptRange.startIndex} to ${transcriptRange.endIndex}`
              : "No message range"}
          </div>
          <div className="mt-1 text-muted-foreground">
            Prompt {promptIndex + 1}
          </div>
        </div>
        {row.kind === "span" && row.span.modelId ? (
          <div className="rounded-md border border-border/50 bg-muted/10 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Model
            </div>
            <div className="mt-1 font-medium text-foreground">
              {row.span.modelId}
            </div>
          </div>
        ) : null}
        {row.kind === "span" && row.span.toolName ? (
          <div className="rounded-md border border-border/50 bg-muted/10 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Tool
            </div>
            <div className="mt-1 font-medium text-foreground">
              {row.span.toolName}
            </div>
            {row.span.serverId ? (
              <div className="mt-1 text-muted-foreground">
                Server {row.span.serverId}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {row.kind === "prompt" ? (
        <div className="rounded-md border border-border/50 bg-muted/10 p-3 text-xs text-muted-foreground">
          {row.counts.step} step{row.counts.step === 1 ? "" : "s"} ·{" "}
          {row.counts.llm} LLM · {row.counts.tool} tool
          {row.counts.tool === 1 ? "" : "s"} · {row.counts.error} error
          {row.counts.error === 1 ? "" : "s"}
        </div>
      ) : null}

      {row.kind === "span" &&
      (typeof row.span.inputTokens === "number" ||
        typeof row.span.outputTokens === "number" ||
        typeof row.span.totalTokens === "number") ? (
        <div className="rounded-md border border-border/50 bg-muted/10 p-3 text-xs">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Tokens
          </div>
          <div className="mt-1 text-foreground">
            {typeof row.span.inputTokens === "number"
              ? `${row.span.inputTokens} in`
              : "no input"}{" "}
            ·{" "}
            {typeof row.span.outputTokens === "number"
              ? `${row.span.outputTokens} out`
              : "no output"}{" "}
            ·{" "}
            {typeof row.span.totalTokens === "number"
              ? `${row.span.totalTokens} total`
              : "no total"}
          </div>
        </div>
      ) : null}

      {showIoTabs ? (
        <Tabs defaultValue="input" className="w-full gap-3">
          <TabsList className="flex h-auto w-full flex-col items-stretch gap-1 p-1">
            <TabsTrigger
              value="input"
              className="h-8 w-full flex-none justify-start px-3 text-xs"
            >
              Input
            </TabsTrigger>
            <TabsTrigger
              value="output"
              className="h-8 w-full flex-none justify-start px-3 text-xs"
            >
              Output
            </TabsTrigger>
            <TabsTrigger
              value="transcript"
              className="h-8 w-full flex-none justify-start px-3 text-xs"
            >
              Transcript
            </TabsTrigger>
          </TabsList>
          <TabsContent value="input" className="mt-3 space-y-2">
            <PayloadPreview value={tabInputValue ?? undefined} height="220px" />
          </TabsContent>
          <TabsContent value="output" className="mt-3 space-y-2">
            <PayloadPreview
              value={tabOutputValue ?? undefined}
              height="220px"
            />
          </TabsContent>
          <TabsContent value="transcript" className="mt-3 space-y-3">
            {transcriptRange && onRevealInTranscript ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full justify-center"
                onClick={() => onRevealInTranscript(transcriptRange)}
              >
                <MessageSquareQuote className="h-3.5 w-3.5" />
                Reveal in transcript
              </Button>
            ) : null}
            {transcriptPreview.length > 0 ? (
              <div className="space-y-2">
                {transcriptPreview.map((entry) => (
                  <div
                    key={`${entry.index}-${entry.role}`}
                    className="rounded-md border border-border/50 bg-muted/10 px-3 py-2 text-xs"
                  >
                    <div className="font-medium text-foreground">
                      #{entry.index} · {entry.role}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {entry.summary}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                No transcript excerpts for this range.
              </div>
            )}
          </TabsContent>
        </Tabs>
      ) : (
        <>
          {transcriptRange && onRevealInTranscript ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full justify-center"
              onClick={() => onRevealInTranscript(transcriptRange)}
            >
              <MessageSquareQuote className="h-3.5 w-3.5" />
              Reveal in transcript
            </Button>
          ) : null}
          {transcriptPreview.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Transcript preview
              </div>
              <div className="space-y-2">
                {transcriptPreview.map((entry) => (
                  <div
                    key={`${entry.index}-${entry.role}`}
                    className="rounded-md border border-border/50 bg-muted/10 px-3 py-2 text-xs"
                  >
                    <div className="font-medium text-foreground">
                      #{entry.index} · {entry.role}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {entry.summary}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}

      {row.kind === "span" &&
      (row.span.category === "error" || toolData.errorText) ? (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Error excerpt
          </div>
          <pre className="max-h-40 overflow-auto rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs whitespace-pre-wrap break-words text-red-900 dark:text-red-100">
            {toolData.errorText ?? row.span.name}
          </pre>
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
  onRevealInTranscript?: (range: TranscriptRange) => void;
}

export function TraceTimeline({
  recordedSpans,
  estimatedDurationMs,
  transcriptMessageCount = 0,
  transcriptMessages = [],
  onRevealInTranscript,
}: TraceTimelineProps) {
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
    ? Math.max(...recordedSpans.map((span) => span.endMs), 1)
    : Math.max(estimatedDurationMs ?? 0, 1);
  const traceIdentity = useMemo(
    () =>
      recordedSpans
        ?.map((span) => `${span.id}:${span.startMs}:${span.endMs}`)
        .join("|") ?? mode,
    [mode, recordedSpans],
  );

  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

  useEffect(() => {
    setExpandedPromptIds(new Set(groups.map((group) => group.key)));
    setExpandedStepIds(collectStepSpanIdsWithChildren(groups));
    setSelectedRowKey(null);
  }, [traceIdentity, groups]);

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
      const childResults = node.children.map((child) =>
        collectNodeRows(child, promptIndex, depth + 1),
      );
      const visibleChildRows = childResults.flatMap((result) => result.rows);
      const hasVisibleChildren = childResults.some(
        (result) => result.hasVisibleContent,
      );
      const isStep = node.span.category === "step";
      const showSelf =
        rowSelfVisible(node.span) || hasVisibleChildren || isStep;

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

      nextRows.push({
        kind: "prompt",
        key: group.key,
        promptIndex: group.promptIndex,
        label: group.label,
        startMs: group.startMs,
        endMs: group.endMs,
        messageStartIndex: group.messageStartIndex,
        messageEndIndex: group.messageEndIndex,
        counts: group.counts,
        hasAnyFailure,
        isExpanded: expandedPromptIds.has(group.key),
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

  return (
    <div className="space-y-2">
      <div className="flex min-h-8 items-center gap-2 overflow-x-auto border-b border-border/30 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground/90">Recorded</span>
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          {groups.length} prompt{groups.length === 1 ? "" : "s"}
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          {formatDuration(maxEndMs)}
        </span>
        <span
          className="bg-border hidden h-3 w-px shrink-0 sm:block"
          aria-hidden
        />
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/50 bg-background p-0.5">
          {FILTERS.map((entry) => (
            <button
              key={entry}
              type="button"
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                filter === entry
                  ? "bg-primary/10 font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setFilter(entry)}
            >
              {entry === "all" ? "All" : entry.toUpperCase()}
            </button>
          ))}
        </div>
        <span
          className="bg-border hidden h-3 w-px shrink-0 md:block"
          aria-hidden
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={groups.length === 0}
          className="h-7 w-7 shrink-0 border-border/50 text-muted-foreground hover:text-foreground disabled:opacity-40"
          title={isFullyExpanded ? "Collapse all" : "Expand all"}
          aria-label={isFullyExpanded ? "Collapse all" : "Expand all"}
          aria-pressed={isFullyExpanded}
          onClick={() => {
            if (isFullyExpanded) {
              setExpandedPromptIds(new Set());
              setExpandedStepIds(new Set());
            } else {
              setExpandedPromptIds(new Set(groups.map((group) => group.key)));
              setExpandedStepIds(new Set(fullyExpandedStepIds));
            }
          }}
        >
          {isFullyExpanded ? (
            <Shrink className="size-3.5" strokeWidth={2} aria-hidden />
          ) : (
            <Expand className="size-3.5" strokeWidth={2} aria-hidden />
          )}
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <div className="min-h-0 overflow-auto rounded-lg border border-border/50 bg-background xl:max-h-[calc(100vh-8rem)]">
          <div
            className="grid min-w-[1100px]"
            style={{
              gridTemplateColumns: `${LABEL_W}px ${TIMELINE_W}px`,
              gridTemplateRows: `auto repeat(${rows.length}, minmax(56px, auto))`,
            }}
          >
            <div
              className="sticky top-0 z-20 border-b border-border/50 bg-background/95 px-4 py-3 backdrop-blur"
              style={{ gridColumn: 1, gridRow: 1 }}
            >
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Waterfall
              </div>
              <div className="mt-1 text-xs text-foreground">
                Prompt, step, and child spans in execution order
              </div>
            </div>
            <div
              className="sticky top-0 z-20 border-b border-border/50 bg-background/95 px-4 py-3 backdrop-blur"
              style={{ gridColumn: 2, gridRow: 1 }}
            >
              <div className="relative h-8">
                {TICKS.map((tick) => {
                  const left = `${tick}%`;
                  return (
                    <div
                      key={tick}
                      className="absolute inset-y-0"
                      style={{ left }}
                    >
                      <div className="absolute -translate-x-1/2 text-[10px] text-muted-foreground">
                        {formatAxisLabel((maxEndMs * tick) / 100)}
                      </div>
                    </div>
                  );
                })}
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
                {TICKS.map((tick) => (
                  <div
                    key={tick}
                    className="absolute top-0 bottom-0 w-px bg-border/40"
                    style={{ left: `${tick}%` }}
                  />
                ))}
              </div>
            ) : null}

            {rows.map((row, rowIndex) => {
              const isSelected = row.key === selectedRowKey;
              const { startMs, endMs, durationMs } = getRowTiming(row);
              const leftPercent = (startMs / maxEndMs) * 100;
              const widthPercent = Math.max(
                ((endMs - startMs) / maxEndMs) * 100,
                0.45,
              );
              const spanShowsFailure =
                row.kind === "span" &&
                spanIndicatesTranscriptFailure(row.span, transcriptMessages);
              const categoryClasses =
                row.kind === "prompt"
                  ? {
                      bar: "bg-violet-500/70",
                      rail: "bg-violet-500/10",
                    }
                  : getCategoryClasses(
                      spanShowsFailure ? "error" : row.span.category,
                    );
              const rowGlyphCategory: EvalTraceSpanCategory | "prompt" =
                row.kind === "prompt"
                  ? "prompt"
                  : row.span.category === "tool" && spanShowsFailure
                    ? "error"
                    : row.span.category;
              const label =
                row.kind === "prompt"
                  ? row.label
                  : deriveSpanLabel(row, transcriptMessages).title;
              const subtitle =
                row.kind === "prompt"
                  ? `${formatOffset(row.startMs)} · ${row.counts.step} step${row.counts.step === 1 ? "" : "s"}`
                  : deriveSpanLabel(row, transcriptMessages).subtitle;
              const canToggle = row.kind === "prompt" ? true : row.hasChildren;
              const gridRow = rowIndex + 2;
              const tokenHint =
                row.kind === "span" ? formatInlineTokenHint(row.span) : null;

              return (
                <Fragment key={row.key}>
                  <div
                    data-testid="trace-row"
                    style={{ gridColumn: 1, gridRow }}
                    className={cn(
                      "flex items-start gap-2 border-b border-border/40 px-4 py-2 transition-colors",
                      isSelected
                        ? "bg-primary/5"
                        : "bg-background hover:bg-muted/20",
                    )}
                  >
                    <div
                      className="flex shrink-0 items-center"
                      style={{
                        paddingLeft: row.kind === "prompt" ? 0 : row.depth * 16,
                      }}
                    >
                      {canToggle ? (
                        <button
                          type="button"
                          className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (row.kind === "prompt") {
                              setExpandedPromptIds((current) => {
                                const next = new Set(current);
                                if (next.has(row.key)) next.delete(row.key);
                                else next.add(row.key);
                                return next;
                              });
                              return;
                            }
                            setExpandedStepIds((current) => {
                              const next = new Set(current);
                              if (next.has(row.key)) next.delete(row.key);
                              else next.add(row.key);
                              return next;
                            });
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
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setSelectedRowKey(row.key)}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {row.kind === "prompt" ? (
                          <CategoryGlyph category="prompt" />
                        ) : (
                          <CategoryGlyph category={rowGlyphCategory} />
                        )}
                        <span className="truncate text-sm font-medium text-foreground">
                          {label}
                        </span>
                        {tokenHint ? (
                          <span
                            className="text-[10px] tabular-nums text-muted-foreground"
                            title="Tokens"
                          >
                            {tokenHint}
                          </span>
                        ) : null}
                        {row.kind === "prompt" && row.hasAnyFailure ? (
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
                      {subtitle ? (
                        <div className="mt-1 truncate text-[11px] text-muted-foreground">
                          {subtitle}
                        </div>
                      ) : null}
                    </button>
                  </div>
                  <button
                    type="button"
                    style={{ gridColumn: 2, gridRow }}
                    className={cn(
                      "relative z-[1] h-full min-h-[56px] w-full border-b border-border/40 px-4 py-2 text-left transition-colors",
                      isSelected
                        ? "bg-primary/5"
                        : "bg-background hover:bg-muted/20",
                    )}
                    onClick={() => setSelectedRowKey(row.key)}
                    title={`${label} · ${formatDuration(durationMs)}`}
                  >
                    <div
                      data-testid={
                        row.kind === "span" && spanShowsFailure
                          ? "trace-row-bar-error"
                          : "trace-row-bar"
                      }
                      className={cn(
                        "absolute top-1/2 z-[1] h-6 -translate-y-1/2 rounded-sm shadow-sm",
                        categoryClasses.bar,
                      )}
                      style={{
                        left: `${leftPercent}%`,
                        width: `max(${widthPercent}%, 3px)`,
                      }}
                    />
                    <div className="relative z-[1] flex h-full items-center pl-4 text-[11px] text-muted-foreground">
                      {formatDuration(durationMs)}
                    </div>
                  </button>
                </Fragment>
              );
            })}
          </div>
        </div>

        <div
          data-testid="trace-timeline-detail-sticky"
          className="min-w-0 xl:sticky xl:top-3 xl:max-h-[calc(100vh-8rem)] xl:self-start xl:overflow-y-auto"
        >
          <TimelineDetailPane
            row={selectedRow}
            transcriptMessages={transcriptMessages}
            onRevealInTranscript={onRevealInTranscript}
          />
        </div>
      </div>
    </div>
  );
}
