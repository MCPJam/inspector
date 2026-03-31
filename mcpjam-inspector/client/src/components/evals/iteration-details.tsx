import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EvalIteration, EvalCase } from "./types";
import { TraceViewer } from "./trace-viewer";
import {
  MessageSquare,
  Code2,
  ChevronDown,
  ChevronRight,
  WifiOff,
  AlertCircle,
} from "lucide-react";
import { ToolServerMap, listTools } from "@/lib/apis/mcp-tools-api";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  getModelById,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
import { cn } from "@/lib/utils";
import { formatConvexBlobLoadError } from "@/lib/convex-action-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const TOOL_ARGUMENT_BLOCK_THRESHOLD = 120;
const TOOL_CALLS_SUMMARY_MAX_LEN = 160;
const EMPTY_SERVER_NAMES: string[] = [];

function formatToolCallsSummary(
  expected: Array<{ toolName: string }>,
  actual: Array<{ toolName: string }>,
  maxLen = TOOL_CALLS_SUMMARY_MAX_LEN,
): string {
  const expPart =
    expected.length === 0 ? "—" : expected.map((t) => t.toolName).join(", ");
  const actPart =
    actual.length === 0 ? "—" : actual.map((t) => t.toolName).join(", ");
  const s = `Expected: ${expPart} · Actual: ${actPart}`;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
const KNOWN_MODEL_PROVIDERS: ModelProvider[] = [
  "anthropic",
  "azure",
  "openai",
  "ollama",
  "deepseek",
  "google",
  "meta",
  "xai",
  "mistral",
  "moonshotai",
  "openrouter",
  "z-ai",
  "minimax",
  "custom",
];

function tryParseStructuredArgumentString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const firstCharacter = trimmed[0];
  if (firstCharacter !== "{" && firstCharacter !== "[") {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function stringifyToolArgumentValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function resolveFormattedArgumentValue(
  value: unknown,
):
  | { kind: "structured"; value: unknown }
  | { kind: "text"; value: string; renderAsBlock: boolean } {
  if (value !== null && typeof value === "object") {
    return { kind: "structured", value };
  }

  if (typeof value === "string") {
    const parsedStructuredValue = tryParseStructuredArgumentString(value);
    if (parsedStructuredValue !== null) {
      return { kind: "structured", value: parsedStructuredValue };
    }
  }

  const textValue = stringifyToolArgumentValue(value);
  return {
    kind: "text",
    value: textValue,
    renderAsBlock:
      textValue.length > TOOL_ARGUMENT_BLOCK_THRESHOLD ||
      textValue.includes("\n"),
  };
}

function normalizeModelProvider(provider?: string): ModelProvider {
  return KNOWN_MODEL_PROVIDERS.includes(provider as ModelProvider)
    ? (provider as ModelProvider)
    : "custom";
}

function resolveTraceModel(
  iteration: EvalIteration,
  testCase: EvalCase | null,
): ModelDefinition {
  const snapshotProvider = iteration.testCaseSnapshot?.provider;
  const snapshotModel = iteration.testCaseSnapshot?.model;
  const fallbackProvider = testCase?.models[0]?.provider;
  const fallbackModel = testCase?.models[0]?.model;

  const provider = snapshotProvider || fallbackProvider || "openai";
  const model = snapshotModel || fallbackModel || "unknown-model";
  const providerModelId =
    model.startsWith(`${provider}/`) || !provider
      ? model
      : `${provider}/${model}`;

  return (
    getModelById(providerModelId) ??
    getModelById(model) ?? {
      id: providerModelId,
      name: model.includes("/") ? model.split("/").slice(1).join("/") : model,
      provider: normalizeModelProvider(provider),
    }
  );
}

function TraceBlobLoadErrorPanel({
  error,
  layoutMode,
  onRetry,
  isDetailsOpen,
  onDetailsOpenChange,
}: {
  error: string;
  layoutMode: "compact" | "full";
  onRetry: () => void;
  isDetailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
}) {
  const info = formatConvexBlobLoadError(error);
  const Icon = info.kind === "transient" ? WifiOff : AlertCircle;
  return (
    <div
      className={cn("space-y-3", layoutMode === "full" && "max-w-md")}
      data-testid="iteration-trace-load-error"
    >
      <Alert variant={info.alertVariant}>
        <Icon />
        <AlertTitle>{info.title}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{info.description}</p>
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
      <Collapsible open={isDetailsOpen} onOpenChange={onDetailsOpenChange}>
        <CollapsibleTrigger
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span>Technical details</span>
          {isDetailsOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap overflow-x-auto rounded border border-border/40 bg-muted/30 p-2">
            {error}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function IterationDetails({
  iteration,
  testCase,
  serverNames = EMPTY_SERVER_NAMES,
  layoutMode = "compact",
  caseInsightSlot,
}: {
  iteration: EvalIteration;
  testCase: EvalCase | null;
  serverNames?: string[];
  layoutMode?: "compact" | "full";
  /** Run-level case insight caption; shown under the trace toolbar or at top when no trace blob. */
  caseInsightSlot?: ReactNode;
}) {
  const getBlob = useAction(
    "testSuites:getTestIterationBlob" as any,
  ) as unknown as (args: { blobId: string }) => Promise<any>;

  const [blob, setBlob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobRetryTick, setBlobRetryTick] = useState(0);
  const [isBlobErrorDetailsOpen, setIsBlobErrorDetailsOpen] = useState(false);
  const prevBlobIdRef = useRef<string | undefined>(undefined);
  const [toolViewMode, setToolViewMode] = useState<"formatted" | "raw">(
    "formatted",
  );
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, any>>
  >({});
  const [toolServerMap, setToolServerMap] = useState<ToolServerMap>({});
  const [connectedServerIds, setConnectedServerIds] = useState<string[]>([]);
  const [toolsWithSchema, setToolsWithSchema] = useState<
    Record<string, { name: string; inputSchema?: any }>
  >({});
  const [toolCallsSectionOpen, setToolCallsSectionOpen] = useState(() =>
    layoutMode === "full" ? iteration.result !== "passed" : true,
  );

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!iteration.blob) {
        prevBlobIdRef.current = undefined;
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
      }
      if (prevBlobIdRef.current !== iteration.blob) {
        prevBlobIdRef.current = iteration.blob;
        setIsBlobErrorDetailsOpen(false);
      }
      setLoading(true);
      setError(null);
      try {
        const data = await getBlob({ blobId: iteration.blob });
        if (!cancelled) setBlob(data);
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Failed to load blob");
          console.error("Blob load error:", e);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [iteration.blob, getBlob, blobRetryTick]);

  useEffect(() => {
    if (layoutMode !== "full") return;
    setToolCallsSectionOpen(iteration.result !== "passed");
  }, [layoutMode, iteration._id, iteration.result]);

  useEffect(() => {
    let cancelled = false;

    if (serverNames.length === 0) {
      setToolsMetadata({});
      setToolServerMap({});
      setToolsWithSchema({});
      setConnectedServerIds([]);
      return () => {
        cancelled = true;
      };
    }

    setToolsMetadata({});
    setToolServerMap({});
    setToolsWithSchema({});
    setConnectedServerIds([]);

    serverNames.forEach((serverId) => {
      void listTools({ serverId })
        .then((result) => {
          if (cancelled) return;

          setConnectedServerIds((prev) =>
            prev.includes(serverId) ? prev : [...prev, serverId],
          );

          if (result.tools?.length) {
            setToolsWithSchema((prev) => {
              const next = { ...prev };
              for (const tool of result.tools ?? []) {
                next[tool.name] = {
                  name: tool.name,
                  inputSchema: tool.inputSchema,
                };
              }
              return next;
            });

            setToolServerMap((prev) => {
              const next = { ...prev };
              for (const tool of result.tools ?? []) {
                next[tool.name] = serverId;
              }
              return next;
            });
          }

          if (result.toolsMetadata) {
            setToolsMetadata((prev) => ({
              ...prev,
              ...Object.fromEntries(
                Object.entries(result.toolsMetadata ?? {}).map(
                  ([toolName, meta]) => [
                    toolName,
                    meta as Record<string, unknown>,
                  ],
                ),
              ),
            }));
          }
        })
        .catch((loadError) => {
          if (cancelled) return;

          console.warn(
            `Failed to fetch tools for server ${serverId}:`,
            loadError,
          );
        });
    });

    return () => {
      cancelled = true;
    };
  }, [serverNames]);

  const traceModel = useMemo(
    () => resolveTraceModel(iteration, testCase),
    [iteration, testCase],
  );

  const estimatedDurationMs = useMemo(
    () =>
      Math.max(
        iteration.updatedAt - (iteration.startedAt ?? iteration.createdAt),
        0,
      ),
    [iteration.updatedAt, iteration.startedAt, iteration.createdAt],
  );
  const traceStartedAtMs = iteration.startedAt ?? iteration.createdAt;
  const traceEndedAtMs = iteration.updatedAt;

  // Use snapshot values first (reflects what was actually tested, including unsaved edits)
  const expectedToolCalls =
    iteration.testCaseSnapshot?.expectedToolCalls ??
    testCase?.expectedToolCalls ??
    [];
  const actualToolCalls = iteration.actualToolCalls || [];

  // Helper to format type information
  const formatType = (type: any): string => {
    if (Array.isArray(type)) {
      return type.join(" | ");
    }
    if (typeof type === "string") {
      return type;
    }
    return String(type);
  };

  // Helper to get argument schema for a tool
  const getArgumentSchema = (toolName: string, argKey: string) => {
    const tool = toolsWithSchema[toolName];
    if (!tool?.inputSchema?.properties) return null;
    return tool.inputSchema.properties[argKey];
  };

  // Helper to render arguments in a readable format
  const renderArguments = (args: Record<string, any>, toolName?: string) => {
    const entries = Object.entries(args);
    if (entries.length === 0) {
      return <span className="text-muted-foreground italic">No arguments</span>;
    }
    return (
      <div className="space-y-2">
        {entries.map(([key, value]) => {
          const argSchema = toolName ? getArgumentSchema(toolName, key) : null;
          const formattedValue = resolveFormattedArgumentValue(value);

          return (
            <div
              key={key}
              className="rounded-md border border-border/20 bg-background/40 px-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground">{key}:</span>
                {argSchema?.type && (
                  <span className="text-[10px] font-normal text-muted-foreground bg-background/50 px-1.5 py-0.5 rounded border border-border/40">
                    {formatType(argSchema.type)}
                  </span>
                )}
              </div>

              {formattedValue.kind === "structured" ? (
                <div className="mt-2 overflow-hidden rounded-md border border-border/30 bg-background/80">
                  <JsonEditor
                    value={formattedValue.value}
                    viewOnly
                    collapsible
                    defaultExpandDepth={1}
                    collapseStringsAfterLength={160}
                    expandJsonStrings
                    className="max-h-72"
                  />
                </div>
              ) : formattedValue.renderAsBlock ? (
                <div className="mt-2 overflow-hidden rounded-md border border-border/30 bg-background/80">
                  <JsonEditor
                    value={formattedValue.value}
                    viewOnly
                    collapsible
                    defaultExpandDepth={1}
                    collapseStringsAfterLength={160}
                    expandJsonStrings
                    className="max-h-72"
                  />
                </div>
              ) : (
                <div className="mt-1 min-w-0 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {formattedValue.value}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderRawToolCalls = (
    toolCalls: Array<{ toolName: string; arguments: Record<string, any> }>,
    emptyMessage: string,
  ) => {
    if (toolCalls.length === 0) {
      return (
        <div className="text-xs text-muted-foreground italic">
          {emptyMessage}
        </div>
      );
    }

    return (
      <div className="overflow-hidden rounded-md border border-border/30 bg-background/50">
        <JsonEditor
          value={toolCalls}
          viewOnly
          collapsible
          defaultExpandDepth={2}
          collapseStringsAfterLength={160}
          className="min-h-[160px] max-h-72"
        />
      </div>
    );
  };

  const parseErrorDetails = (details: string | undefined) => {
    if (!details) return null;
    try {
      const parsed = JSON.parse(details);
      return parsed;
    } catch {
      return null;
    }
  };

  const errorDetailsJson = parseErrorDetails(iteration.errorDetails);
  const [isErrorDetailsOpen, setIsErrorDetailsOpen] = useState(false);

  const hasToolCalls =
    expectedToolCalls.length > 0 || actualToolCalls.length > 0;
  const traceFirst = layoutMode === "full" && Boolean(iteration.blob);
  const toolCallsSummary = formatToolCallsSummary(
    expectedToolCalls,
    actualToolCalls,
  );

  const toolCallsGrids =
    toolViewMode === "raw" ? (
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase">
            Expected
          </div>
          {renderRawToolCalls(expectedToolCalls, "No expected tool calls")}
        </div>
        <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase">
            Actual
          </div>
          {renderRawToolCalls(actualToolCalls, "No tool calls made")}
        </div>
      </div>
    ) : (
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-md border border-border/40 bg-muted/10 p-2 space-y-2">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            Expected
          </div>
          {expectedToolCalls.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              No expected tool calls
            </div>
          ) : (
            <div className="space-y-1.5">
              {expectedToolCalls.map((tool, idx) => (
                <div
                  key={`expected-${idx}`}
                  className="rounded border border-border/30 bg-background/50 p-1.5 space-y-1"
                >
                  <div className="font-mono text-xs font-medium">
                    {tool.toolName}
                  </div>
                  {Object.keys(tool.arguments || {}).length > 0 && (
                    <div className="text-xs bg-muted/30 rounded p-1.5">
                      {renderArguments(tool.arguments || {}, tool.toolName)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-md border border-border/40 bg-muted/10 p-2 space-y-2">
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            Actual
          </div>
          {actualToolCalls.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">
              No tool calls made
            </div>
          ) : (
            <div className="space-y-1.5">
              {actualToolCalls.map((tool, idx) => (
                <div
                  key={`actual-${idx}`}
                  className="rounded border border-border/30 bg-background/50 p-1.5 space-y-1"
                >
                  <div className="font-mono text-xs font-medium">
                    {tool.toolName}
                  </div>
                  {Object.keys(tool.arguments || {}).length > 0 && (
                    <div className="text-xs bg-muted/30 rounded p-1.5">
                      {renderArguments(tool.arguments || {}, tool.toolName)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );

  const formattedRawToggle = (
    <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background p-0.5">
      <button
        type="button"
        onClick={() => setToolViewMode("formatted")}
        className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
          toolViewMode === "formatted"
            ? "bg-primary/10 text-foreground font-medium"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Formatted view"
      >
        <MessageSquare className="h-3 w-3" />
        Formatted
      </button>
      <button
        type="button"
        onClick={() => setToolViewMode("raw")}
        className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
          toolViewMode === "raw"
            ? "bg-primary/10 text-foreground font-medium"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Raw JSON view"
      >
        <Code2 className="h-3 w-3" />
        Raw
      </button>
    </div>
  );

  const toolCallsSection =
    hasToolCalls && !iteration.blob ? (
    layoutMode === "full" ? (
      <Collapsible
        open={toolCallsSectionOpen}
        onOpenChange={setToolCallsSectionOpen}
      >
        <div className="space-y-2" data-testid="iteration-tool-calls-section">
          <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border/40 pb-2">
            <CollapsibleTrigger
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              {toolCallsSectionOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="shrink-0 text-xs font-semibold">Tool Calls</span>
              {!toolCallsSectionOpen && (
                <span
                  className="min-w-0 truncate text-xs text-muted-foreground"
                  title={toolCallsSummary}
                >
                  {toolCallsSummary}
                </span>
              )}
            </CollapsibleTrigger>
            {toolCallsSectionOpen ? formattedRawToggle : null}
          </div>
          <CollapsibleContent>
            <div className="space-y-2" data-testid="iteration-tool-calls-grid">
              {toolCallsGrids}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    ) : (
      <div className="space-y-2" data-testid="iteration-tool-calls-section">
        <div className="flex items-center justify-between border-b border-border/40 pb-2">
          <div className="text-xs font-semibold">Tool Calls</div>
          {formattedRawToggle}
        </div>
        <div data-testid="iteration-tool-calls-grid">{toolCallsGrids}</div>
      </div>
    )
  ) : null;

  const traceSection = iteration.blob ? (
    <div
      className={cn(
        "flex flex-col",
        layoutMode === "full" && "min-h-0 flex-1",
        layoutMode === "full" ? "gap-1" : "gap-1.5",
      )}
      data-testid="iteration-trace-section"
    >
      {layoutMode !== "full" ? (
        <div className="text-xs font-semibold">Trace</div>
      ) : null}
      <div
        className={cn(
          layoutMode === "compact" &&
            "rounded-md bg-muted/20 p-3 max-h-[480px] overflow-y-auto",
          layoutMode === "full" &&
            iteration.blob &&
            !error &&
            "flex min-h-0 flex-1 flex-col",
          layoutMode === "full" &&
            error &&
            !loading &&
            "min-h-[320px] flex flex-col justify-center",
        )}
      >
        {loading ? (
          <div className="text-xs text-muted-foreground">Loading trace</div>
        ) : error ? (
          <TraceBlobLoadErrorPanel
            error={error}
            layoutMode={layoutMode}
            onRetry={() => setBlobRetryTick((n) => n + 1)}
            isDetailsOpen={isBlobErrorDetailsOpen}
            onDetailsOpenChange={setIsBlobErrorDetailsOpen}
          />
        ) : (
          <TraceViewer
            trace={blob}
            model={traceModel}
            toolsMetadata={toolsMetadata}
            toolServerMap={toolServerMap}
            connectedServerIds={connectedServerIds}
            traceStartedAtMs={traceStartedAtMs}
            traceEndedAtMs={traceEndedAtMs}
            estimatedDurationMs={estimatedDurationMs}
            traceInsight={caseInsightSlot}
            chromeDensity={
              layoutMode === "full" ? "compact" : "default"
            }
            expectedToolCalls={expectedToolCalls}
            actualToolCalls={actualToolCalls}
          />
        )}
      </div>
    </div>
  ) : null;

  const caseInsightFallback =
    caseInsightSlot && !iteration.blob ? (
      <div className="min-w-0" data-testid="iteration-case-insight-fallback">
        {caseInsightSlot}
      </div>
    ) : null;

  return (
    <div
      className={cn(
        "flex flex-col",
        layoutMode === "full" && "min-h-0 flex-1",
        layoutMode === "full" ? "gap-3" : "gap-4 py-2",
      )}
    >
      {/* Error Display */}
      {iteration.error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 space-y-2">
          <div className="text-xs font-semibold text-destructive uppercase tracking-wide">
            Error
          </div>
          <div className="text-xs text-destructive whitespace-pre-wrap font-mono">
            {iteration.error}
          </div>
          {iteration.errorDetails && (
            <Collapsible
              open={isErrorDetailsOpen}
              onOpenChange={setIsErrorDetailsOpen}
            >
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80 transition-colors">
                <span>More details</span>
                {isErrorDetailsOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <div className="rounded border border-destructive/30 bg-background/50 p-2">
                  {errorDetailsJson ? (
                    <JsonEditor
                      height="100%"
                      value={errorDetailsJson}
                      readOnly
                      showToolbar={false}
                    />
                  ) : (
                    <pre className="text-xs font-mono text-destructive whitespace-pre-wrap overflow-x-auto">
                      {iteration.errorDetails}
                    </pre>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      )}

      {caseInsightFallback}

      {traceFirst ? (
        <>
          {traceSection}
          {toolCallsSection}
        </>
      ) : (
        <>
          {toolCallsSection}
          {traceSection}
        </>
      )}
    </div>
  );
}
