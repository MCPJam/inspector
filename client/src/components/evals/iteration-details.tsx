import { useAction } from "convex/react";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { formatTime } from "./helpers";
import { EvalIteration, EvalCase } from "./types";
import { TraceViewer } from "./trace-viewer";
import { ToolCallsDisplay } from "./tool-calls-display";
import { CheckCircle2, XCircle, AlertCircle } from "lucide-react";

export function IterationDetails({
  iteration,
  testCase,
}: {
  iteration: EvalIteration;
  testCase: EvalCase | null;
}) {
  const getBlob = useAction(
    "evals:getEvalTestBlob" as any,
  ) as unknown as (args: { blobId: string }) => Promise<any>;

  const [blob, setBlob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const expectedToolCalls = testCase?.expectedToolCalls || iteration.testCaseSnapshot?.expectedToolCalls || [];
  const actualToolCalls = iteration.actualToolCalls || [];

  // Check if arguments match for each tool
  const getToolStatus = (toolName: string) => {
    const expected = expectedToolCalls.find((t) => t.toolName === toolName);
    const actual = actualToolCalls.find((t) => t.toolName === toolName);

    if (!expected && actual) return "unexpected";
    if (expected && !actual) return "missing";
    if (expected && actual) {
      // Check if arguments match
      const expectedArgs = expected.arguments || {};
      const actualArgs = actual.arguments || {};

      // If no expected args, any args are fine
      if (Object.keys(expectedArgs).length === 0) return "match";

      // Check if all expected args match
      for (const [key, value] of Object.entries(expectedArgs)) {
        if (JSON.stringify(actualArgs[key]) !== JSON.stringify(value)) {
          return "argument-mismatch";
        }
      }
      return "match";
    }
    return "unknown";
  };

  return (
    <div className="space-y-4 py-2">
      {/* Tool Calls Comparison */}
      <div className="space-y-2">
        <div className="text-xs font-semibold">Tool Calls Comparison</div>
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
      </div>

      {/* Status Indicators */}
      {(expectedToolCalls.length > 0 || actualToolCalls.length > 0) && (
        <div className="space-y-2">
          <div className="text-xs font-semibold">Status</div>
          <div className="space-y-1.5">
            {/* Check each expected tool */}
            {expectedToolCalls.map((tool, idx) => {
              const status = getToolStatus(tool.toolName);
              return (
                <div
                  key={`expected-${idx}`}
                  className="flex items-start gap-2 text-xs"
                >
                  <div>
                    <span className="font-mono font-medium">{tool.toolName}</span>
                    {status === "match" && (
                      <span className="text-green-600 ml-2">Called with correct arguments</span>
                    )}
                    {status === "missing" && (
                      <span className="text-red-600 ml-2">Not called</span>
                    )}
                    {status === "argument-mismatch" && (
                      <span className="text-yellow-600 ml-2">Called with incorrect arguments</span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Check for unexpected tools */}
            {actualToolCalls
              .filter((actual) => !expectedToolCalls.some((exp) => exp.toolName === actual.toolName))
              .map((tool, idx) => (
                <div
                  key={`unexpected-${idx}`}
                  className="flex items-start gap-2 text-xs"
                >
                  <AlertCircle className="h-4 w-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="font-mono font-medium">{tool.toolName}</span>
                    <span className="text-yellow-600 ml-2">⚠ Unexpected tool call</span>
                  </div>
                </div>
              ))}
          </div>
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
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
