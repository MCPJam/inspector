import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, MessageSquareQuote } from "lucide-react";
import type { EvalTraceSpan, EvalTraceSpanCategory } from "@/shared/eval-trace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "@/components/ui/json-editor";
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

function getMessageParts(message: TranscriptMessage): Record<string, unknown>[] {
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

        if (typeof part.error === "string" && part.error.trim()) {
          errorText = part.error.trim();
        } else if (isRecord(part.error) && typeof part.error.message === "string") {
          errorText = part.error.message;
        } else if (
          isRecord(part.output) &&
          part.output.type === "error-text" &&
          typeof part.output.value === "string"
        ) {
          errorText = part.output.value;
        } else if (part.isError === true) {
          errorText = summarizeValue(output);
        }
      }
    }
  }

  return { input, output, errorText };
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

function getPromptRowTranscriptRange(row: PromptRow): TranscriptRange | undefined {
  return getTranscriptRange(row.messageStartIndex, row.messageEndIndex);
}

function getSpanRowTranscriptRange(row: SpanRow): TranscriptRange | undefined {
  return getTranscriptRange(
    row.span.messageStartIndex,
    row.span.messageEndIndex,
  );
}

function getCategoryClasses(category: EvalTraceSpanCategory): {
  badge: string;
  bar: string;
  rail: string;
} {
  switch (category) {
    case "step":
      return {
        badge: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-200",
        bar: "bg-slate-500/85",
        rail: "bg-slate-500/10",
      };
    case "llm":
      return {
        badge: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        bar: "bg-blue-500/85",
        rail: "bg-blue-500/10",
      };
    case "tool":
      return {
        badge: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        bar: "bg-amber-500/85",
        rail: "bg-amber-500/10",
      };
    case "error":
      return {
        badge: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
        bar: "bg-red-500/85",
        rail: "bg-red-500/10",
      };
    default:
      return {
        badge: "border-border bg-muted text-muted-foreground",
        bar: "bg-muted-foreground/60",
        rail: "bg-muted/40",
      };
  }
}

function buildPromptGroups(spans: EvalTraceSpan[]): PromptGroup[] {
  const spansByPrompt = new Map<number, EvalTraceSpan[]>();
  for (const span of spans) {
    const promptIndex = typeof span.promptIndex === "number" ? span.promptIndex : 0;
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
          typeof span.parentId === "string" ? nodesById.get(span.parentId) : undefined;
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

function deriveSpanLabel(row: SpanRow): {
  title: string;
  subtitle?: string;
} {
  const { span, promptIndex } = row;
  if (span.category === "step") {
    const stepNumber =
      typeof span.stepIndex === "number" ? span.stepIndex + 1 : span.name;
    return {
      title:
        typeof stepNumber === "number"
          ? `Prompt ${promptIndex + 1} · Step ${stepNumber}`
          : `Prompt ${promptIndex + 1} · ${span.name}`,
      subtitle: span.modelId ? `Model ${span.modelId}` : span.name,
    };
  }

  if (span.category === "llm") {
    return {
      title: span.modelId ?? span.name,
      subtitle:
        typeof span.stepIndex === "number"
          ? `Prompt ${promptIndex + 1} · Step ${span.stepIndex + 1}`
          : `Prompt ${promptIndex + 1}`,
    };
  }

  if (span.category === "tool") {
    return {
      title: span.toolName ?? span.name,
      subtitle:
        typeof span.stepIndex === "number"
          ? `Prompt ${promptIndex + 1} · Step ${span.stepIndex + 1}`
          : `Prompt ${promptIndex + 1}`,
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

function getSlowThreshold(maxEndMs: number): number {
  return Math.max(250, Math.round(maxEndMs * 0.08));
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
        Select a prompt, step, or child row to inspect timing and transcript context.
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
    row.kind === "prompt" ? row.label : deriveSpanLabel(row).title;
  const subtitle =
    row.kind === "prompt" ? formatOffset(row.startMs) : deriveSpanLabel(row).subtitle;
  const status =
    row.kind === "prompt"
      ? row.counts.error > 0
        ? "error"
        : "ok"
      : row.span.status;

  return (
    <div
      data-testid="trace-detail-pane"
      className="space-y-4 rounded-lg border border-border/50 bg-background p-4"
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {row.kind === "prompt" ? "Prompt" : row.span.category.toUpperCase()}
          </Badge>
          {status ? (
            <Badge
              variant="outline"
              className={cn(
                "text-[10px]",
                status === "error"
                  ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              )}
            >
              {status === "error" ? "Error" : "OK"}
            </Badge>
          ) : null}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{label}</h3>
          {subtitle ? (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
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
            Transcript
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
          {row.counts.step} step{row.counts.step === 1 ? "" : "s"} · {row.counts.llm}{" "}
          LLM · {row.counts.tool} tool{row.counts.tool === 1 ? "" : "s"} ·{" "}
          {row.counts.error} error{row.counts.error === 1 ? "" : "s"}
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
            Transcript Preview
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
                <div className="mt-1 text-muted-foreground">{entry.summary}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {row.kind === "span" && row.span.toolCallId ? (
        <div className="space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Tool Input
            </div>
            <div className="mt-2">
              <PayloadPreview value={toolData.input} />
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Tool Output
            </div>
            <div className="mt-2">
              <PayloadPreview value={toolData.output} />
            </div>
          </div>
        </div>
      ) : null}

      {row.kind === "span" &&
      (row.span.category === "error" || toolData.errorText) ? (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Error Excerpt
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
  const mode = recordedSpans && recordedSpans.length > 0
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
  const slowThreshold = getSlowThreshold(maxEndMs);
  const traceIdentity = useMemo(
    () =>
      recordedSpans?.map((span) => `${span.id}:${span.startMs}:${span.endMs}`).join("|") ??
      mode,
    [mode, recordedSpans],
  );

  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [slowOnly, setSlowOnly] = useState(false);
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(new Set());
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(new Set());
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

  useEffect(() => {
    setExpandedPromptIds(new Set(groups.map((group) => group.key)));
    setExpandedStepIds(new Set());
    setSelectedRowKey(null);
  }, [traceIdentity, groups]);

  const rows = useMemo(() => {
    if (mode !== "recorded") {
      return [] as TimelineRow[];
    }

    const nextRows: TimelineRow[] = [];

    function rowSelfVisible(span: EvalTraceSpan): boolean {
      const matchesFilter = filter === "all" || span.category === filter;
      const matchesSlow = !slowOnly || span.category === "error" || span.endMs - span.startMs >= slowThreshold;
      return matchesFilter && matchesSlow;
    }

    function collectNodeRows(node: TraceNode, promptIndex: number, depth: number): {
      hasVisibleContent: boolean;
      rows: TimelineRow[];
    } {
      const childResults = node.children.map((child) =>
        collectNodeRows(child, promptIndex, depth + 1),
      );
      const visibleChildRows = childResults.flatMap((result) => result.rows);
      const hasVisibleChildren = childResults.some((result) => result.hasVisibleContent);
      const isStep = node.span.category === "step";
      const showSelf = rowSelfVisible(node.span) || hasVisibleChildren || isStep;

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
        childRows.length > 0 ||
        (!slowOnly && filter === "all" && group.spans.length > 0);

      if (!hasVisibleContent) {
        continue;
      }

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
    slowOnly,
    slowThreshold,
  ]);

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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="bg-muted/20">
            Recorded timing
          </Badge>
          <span className="text-xs text-muted-foreground">
            {groups.length} prompt{groups.length === 1 ? "" : "s"} ·{" "}
            {formatDuration(maxEndMs)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border/50 bg-background p-1">
            {FILTERS.map((entry) => (
              <button
                key={entry}
                type="button"
                className={cn(
                  "rounded px-2 py-1 text-[11px] transition-colors",
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
          <button
            type="button"
            className={cn(
              "rounded-md border px-2 py-1 text-[11px] transition-colors",
              slowOnly
                ? "border-primary/30 bg-primary/10 text-foreground"
                : "border-border/50 bg-background text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setSlowOnly((current) => !current)}
          >
            Slow only ({formatDuration(slowThreshold)}+)
          </button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setExpandedPromptIds(new Set(groups.map((group) => group.key)));
              setExpandedStepIds(
                new Set(
                  recordedSpans
                    ?.filter((span) => span.category === "step")
                    .map((span) => span.id) ?? [],
                ),
              );
            }}
          >
            Expand all
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setExpandedPromptIds(new Set());
              setExpandedStepIds(new Set());
            }}
          >
            Collapse all
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="overflow-auto rounded-lg border border-border/50 bg-background">
          <div
            className="grid min-w-[1100px]"
            style={{
              gridTemplateColumns: `${LABEL_W}px ${TIMELINE_W}px`,
            }}
          >
            <div className="sticky top-0 z-20 border-b border-border/50 bg-background/95 px-4 py-3 backdrop-blur">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Waterfall
              </div>
              <div className="mt-1 text-xs text-foreground">
                Prompt, step, and child spans in execution order
              </div>
            </div>
            <div className="sticky top-0 z-20 border-b border-border/50 bg-background/95 px-4 py-3 backdrop-blur">
              <div className="relative h-8">
                {TICKS.map((tick) => {
                  const left = `${tick}%`;
                  return (
                    <div
                      key={tick}
                      className="absolute inset-y-0"
                      style={{ left }}
                    >
                      <div className="absolute inset-y-0 w-px bg-border/50" />
                      <div className="absolute -translate-x-1/2 text-[10px] text-muted-foreground">
                        {formatAxisLabel((maxEndMs * tick) / 100)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {rows.map((row) => {
              const isSelected = row.key === selectedRowKey;
              const { startMs, endMs, durationMs } = getRowTiming(row);
              const leftPercent = (startMs / maxEndMs) * 100;
              const widthPercent = Math.max(
                ((endMs - startMs) / maxEndMs) * 100,
                0.45,
              );
              const categoryClasses =
                row.kind === "prompt"
                  ? {
                      badge:
                        "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
                      bar: "bg-violet-500/70",
                      rail: "bg-violet-500/10",
                    }
                  : getCategoryClasses(row.span.category);
              const label =
                row.kind === "prompt" ? row.label : deriveSpanLabel(row).title;
              const subtitle =
                row.kind === "prompt"
                  ? `${formatOffset(row.startMs)} · ${row.counts.step} step${row.counts.step === 1 ? "" : "s"}`
                  : deriveSpanLabel(row).subtitle;
              const canToggle =
                row.kind === "prompt" ? true : row.hasChildren;

              return (
                <FragmentRow
                  key={row.key}
                  left={
                    <div
                      data-testid="trace-row"
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
                          <span className="truncate text-sm font-medium text-foreground">
                            {label}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn("text-[10px]", categoryClasses.badge)}
                          >
                            {row.kind === "prompt"
                              ? "Prompt"
                              : row.span.category.toUpperCase()}
                          </Badge>
                          {row.kind === "span" && row.span.status ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                row.span.status === "error"
                                  ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                              )}
                            >
                              {row.span.status === "error" ? "Error" : "OK"}
                            </Badge>
                          ) : null}
                        </div>
                        {subtitle ? (
                          <div className="mt-1 truncate text-[11px] text-muted-foreground">
                            {subtitle}
                          </div>
                        ) : null}
                      </button>
                    </div>
                  }
                  right={
                    <button
                      type="button"
                      className={cn(
                        "relative h-full min-h-[56px] w-full border-b border-border/40 px-4 py-2 text-left transition-colors",
                        isSelected
                          ? "bg-primary/5"
                          : "bg-background hover:bg-muted/20",
                      )}
                      onClick={() => setSelectedRowKey(row.key)}
                      title={`${label} · ${formatDuration(durationMs)}`}
                    >
                      {TICKS.map((tick) => (
                        <div
                          key={tick}
                          className="absolute inset-y-0 w-px bg-border/40"
                          style={{ left: `${tick}%` }}
                        />
                      ))}
                      <div
                        className={cn(
                          "absolute top-1/2 h-6 -translate-y-1/2 rounded-sm shadow-sm",
                          categoryClasses.bar,
                        )}
                        style={{
                          left: `${leftPercent}%`,
                          width: `max(${widthPercent}%, 3px)`,
                        }}
                      />
                      <div className="absolute inset-y-0 left-4 flex items-center text-[11px] text-muted-foreground">
                        {formatDuration(durationMs)}
                      </div>
                    </button>
                  }
                />
              );
            })}
          </div>
        </div>

        <TimelineDetailPane
          row={selectedRow}
          transcriptMessages={transcriptMessages}
          onRevealInTranscript={onRevealInTranscript}
        />
      </div>
    </div>
  );
}

function FragmentRow({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <>
      {left}
      {right}
    </>
  );
}
