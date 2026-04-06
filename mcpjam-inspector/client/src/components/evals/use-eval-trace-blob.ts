import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import type { EvalIteration } from "./types";

export function useEvalTraceBlob({
  iteration,
  onTraceLoaded,
  enabled = true,
}: {
  iteration: EvalIteration | null;
  onTraceLoaded?: () => void;
  enabled?: boolean;
}) {
  const getBlob = useAction(
    "testSuites:getTestIterationBlob" as any,
  ) as unknown as (args: { blobId: string }) => Promise<any>;
  const [blob, setBlob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onTraceLoadedRef = useRef(onTraceLoaded);

  useEffect(() => {
    onTraceLoadedRef.current = onTraceLoaded;
  }, [onTraceLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!enabled) {
        setLoading(false);
        setError(null);
        return;
      }

      if (!iteration?.blob) {
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const data = await getBlob({ blobId: iteration.blob });
        if (!cancelled) {
          setBlob(data);
          onTraceLoadedRef.current?.();
        }
      } catch (loadError: any) {
        if (!cancelled) {
          setError(loadError?.message || "Failed to load trace");
          setBlob(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [enabled, getBlob, iteration?.blob]);

  return {
    blob,
    loading,
    error,
  };
}
