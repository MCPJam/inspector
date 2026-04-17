import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EvalTraceBlobV1 } from "@/shared/eval-trace";
import type { EvalIteration } from "./types";

function buildInlineTraceBlob(
  iteration: EvalIteration | null,
): EvalTraceBlobV1 | null {
  if (!iteration) {
    return null;
  }

  const hasMessages =
    Array.isArray(iteration.messages) && iteration.messages.length > 0;
  const hasSpans = Array.isArray(iteration.spans) && iteration.spans.length > 0;
  const hasPrompts =
    Array.isArray(iteration.prompts) && iteration.prompts.length > 0;

  if (!hasMessages && !hasSpans && !hasPrompts) {
    return null;
  }

  return {
    traceVersion: 1,
    messages: iteration.messages ?? [],
    ...(hasSpans ? { spans: iteration.spans } : {}),
    ...(hasPrompts ? { prompts: iteration.prompts } : {}),
  };
}

export function useEvalTraceBlob({
  iteration,
  onTraceLoaded,
  enabled = true,
  retryKey = 0,
}: {
  iteration: EvalIteration | null;
  onTraceLoaded?: () => void;
  enabled?: boolean;
  retryKey?: number;
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

  const inlineTraceBlob = useMemo(
    () => buildInlineTraceBlob(iteration),
    [iteration],
  );

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!enabled) {
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
      }

      if (!iteration?.blob && inlineTraceBlob) {
        setBlob(inlineTraceBlob);
        setLoading(false);
        setError(null);
        onTraceLoadedRef.current?.();
        return;
      }

      if (!iteration?.blob) {
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
      }

      setBlob(null);
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
  }, [enabled, getBlob, inlineTraceBlob, iteration?.blob, retryKey]);

  return {
    blob,
    loading,
    error,
  };
}
