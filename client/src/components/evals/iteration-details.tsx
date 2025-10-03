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
    <div className="space-y-3 py-2">
      {(testCase?.expectedToolCalls.length || 0) > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Expected tools</div>
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
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Actual tools called</div>
          <div className="flex flex-wrap gap-1.5">
            {iteration.actualToolCalls.map((tool, idx) => {
              return (
                <Badge
                  key={idx}
                  variant="outline"
                  className="font-mono text-xs"
                >
                  {tool}
                </Badge>
              );
            })}
          </div>
        </div>
      )}

      {iteration.blob && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold">Trace</div>
          <div className="rounded-md bg-muted/20 p-3">
            {loading ? (
              <div className="text-xs text-muted-foreground">Loading trace</div>
            ) : error ? (
              <div className="text-xs text-red-600">{error}</div>
            ) : (
              <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(blob, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
