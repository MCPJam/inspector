import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import type { EvalIteration } from "./types";
import { registerArtifactUrls, useArtifactUrlEpoch } from "@/lib/artifact-urls";

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
  ) as unknown as (args: { iterationId: string }) => Promise<any>;
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
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
      }

      if (!iteration?.blob && !iteration?.chatSessionId) {
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
      }

      setBlob(null);
      setLoading(true);
      setError(null);

      try {
        // Backend authorizes via the iteration's testSuite and resolves the
        // trace server-side from either the legacy blob or the unified
        // chatSessions path. Gate skips the roundtrip only when neither
        // source is present.
        const data = await getBlob({ iterationId: iteration._id });
        registerArtifactUrls(data);
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
  }, [enabled, getBlob, iteration?.blob, iteration?.chatSessionId]);

  // The trace's widget HTML and screenshots arrive as short-lived artifact
  // links. When one expires anywhere on the page, re-read the trace in the
  // background and swap the fresh links in without blanking the view.
  const artifactUrlEpoch = useArtifactUrlEpoch();
  const handledArtifactUrlEpochRef = useRef(artifactUrlEpoch);
  const iterationId = iteration?._id;
  const hasTraceSource = Boolean(iteration?.blob || iteration?.chatSessionId);
  useEffect(() => {
    if (artifactUrlEpoch === handledArtifactUrlEpochRef.current) return;
    handledArtifactUrlEpochRef.current = artifactUrlEpoch;
    if (!enabled || !iterationId || !hasTraceSource) return;
    let cancelled = false;
    getBlob({ iterationId })
      .then((data) => {
        registerArtifactUrls(data);
        if (!cancelled) setBlob(data);
      })
      .catch(() => {
        // Keep what is shown; the next expired link retries.
      });
    return () => {
      cancelled = true;
    };
  }, [artifactUrlEpoch, enabled, getBlob, hasTraceSource, iterationId]);

  return {
    blob,
    loading,
    error,
  };
}
