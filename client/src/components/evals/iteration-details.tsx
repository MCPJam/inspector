import { useAction } from "convex/react";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { formatTime } from "./helpers";
import { EvalIteration, EvalCase } from "./types";

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

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Status</span>
        <Badge className="capitalize">{iteration.status}</Badge>
        <span className="mx-1 text-muted-foreground">·</span>
        <span className="font-semibold">Result</span>
        <Badge className="capitalize">{iteration.result}</Badge>
      </div>
      <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
        <div>Started {formatTime(iteration.startedAt)}</div>
        <div>Updated {formatTime(iteration.updatedAt)}</div>
        <div>Tokens {Number(iteration.tokensUsed || 0).toLocaleString()}</div>
        <div>Tool calls {iteration.actualToolCalls.length}</div>
      </div>
      {(testCase?.expectedToolCalls.length || 0) > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-semibold">Expected tools:</div>
          <div className="flex flex-wrap gap-1.5">
            {testCase?.expectedToolCalls.map((tool, idx) => (
              <Badge key={idx} variant="outline" className="font-mono text-xs">
                {tool}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {iteration.actualToolCalls.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-semibold">Actual tools called:</div>
          <div className="flex flex-wrap gap-1.5">
            {iteration.actualToolCalls.map((tool, idx) => {
              const isExpected = testCase?.expectedToolCalls.includes(tool);
              const isMissing = false; // actual tools can't be missing
              return (
                <Badge
                  key={idx}
                  variant={isExpected ? "default" : "destructive"}
                  className="font-mono text-xs"
                >
                  {tool}
                </Badge>
              );
            })}
          </div>
        </div>
      )}
      <div className="rounded-md border bg-muted/40 p-3">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading blob…</div>
        ) : error ? (
          <div className="text-sm text-red-600">{error}</div>
        ) : iteration.blob ? (
          <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(blob, null, 2)}
          </pre>
        ) : (
          <div className="text-sm text-muted-foreground">
            No blob attached to this iteration.
          </div>
        )}
      </div>
    </div>
  );
}
