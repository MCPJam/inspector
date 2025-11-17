import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { EvalIteration, EvalCase } from "./types";
import { TraceViewer } from "./trace-viewer";
import { MessageSquare, Code2 } from "lucide-react";
import { getToolsMetadata, ToolServerMap } from "@/lib/mcp-tools-api";

export function IterationDetails({
  iteration,
  testCase,
  serverNames = [],
}: {
  iteration: EvalIteration;
  testCase: EvalCase | null;
  serverNames?: string[];
}) {
  const getBlob = useAction(
    "testSuites:getTestIterationBlob" as any,
  ) as unknown as (args: { blobId: string }) => Promise<any>;

  const [blob, setBlob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolViewMode, setToolViewMode] = useState<"formatted" | "raw">(
    "formatted",
  );
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, any>>
  >({});
  const [toolServerMap, setToolServerMap] = useState<ToolServerMap>({});

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!iteration.blob) {
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
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
  }, [iteration.blob, getBlob]);

  useEffect(() => {
    const fetchToolsMetadata = async () => {
      if (serverNames.length === 0) {
        setToolsMetadata({});
        setToolServerMap({});
        return;
      }
      try {
        // Filter to only connected servers to avoid 404 errors
        // In evals, serverNames might contain servers that aren't currently connected
        const { metadata, toolServerMap } = await getToolsMetadata(serverNames);
        setToolsMetadata(metadata);
        setToolServerMap(toolServerMap);
      } catch (error) {
        // Silently fail if servers aren't connected
        // This is expected in evals where servers may not be running
        setToolsMetadata({});
        setToolServerMap({});
      }
    };
    fetchToolsMetadata();
  }, [serverNames]);

  // Use snapshot values first (reflects what was actually tested, including unsaved edits)
  const expectedToolCalls =
    iteration.testCaseSnapshot?.expectedToolCalls ||
    testCase?.expectedToolCalls ||
    [];
  const actualToolCalls = iteration.actualToolCalls || [];

  // Helper to render arguments in a readable format
  const renderArguments = (args: Record<string, any>) => {
    const entries = Object.entries(args);
    if (entries.length === 0) {
      return <span className="text-muted-foreground italic">No arguments</span>;
    }
    return (
      <div className="space-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-2">
            <span className="font-medium text-foreground">{key}:</span>
            <span className="font-mono text-muted-foreground">
              {typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-4 py-2">
      {/* Tool Calls Comparison & Status */}
      {(expectedToolCalls.length > 0 || actualToolCalls.length > 0) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between border-b border-border/40 pb-2">
            <div className="text-xs font-semibold">Tool Calls</div>
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
          </div>

          {toolViewMode === "raw" ? (
            <div className="grid gap-3 md:grid-cols-2">
              {/* Expected */}
              <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase">
                  Expected
                </div>
                {expectedToolCalls.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">
                    No expected tool calls
                  </div>
                ) : (
                  <pre className="text-xs font-mono bg-background/50 rounded p-2 overflow-x-auto">
                    {JSON.stringify(expectedToolCalls, null, 2)}
                  </pre>
                )}
              </div>

              {/* Actual */}
              <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2">
                <div className="text-xs font-medium text-muted-foreground uppercase">
                  Actual
                </div>
                {actualToolCalls.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">
                    No tool calls made
                  </div>
                ) : (
                  <pre className="text-xs font-mono bg-background/50 rounded p-2 overflow-x-auto">
                    {JSON.stringify(actualToolCalls, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {/* Expected */}
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
                            {renderArguments(tool.arguments || {})}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Actual */}
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
                            {renderArguments(tool.arguments || {})}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Trace */}
      {iteration.blob && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Trace</div>
          <div className="rounded-md bg-muted/20 p-3 max-h-[480px] overflow-y-auto">
            {loading ? (
              <div className="text-xs text-muted-foreground">Loading trace</div>
            ) : error ? (
              <div className="text-xs text-red-600">{error}</div>
            ) : (
              <TraceViewer
                trace={blob}
                modelProvider={
                  testCase?.provider ||
                  iteration.testCaseSnapshot?.provider ||
                  "openai"
                }
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
