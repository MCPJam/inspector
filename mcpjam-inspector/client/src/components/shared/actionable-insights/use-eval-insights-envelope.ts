import { useAction, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useState } from "react";
import {
  INSIGHTS_ENVELOPE_READS,
  type InsightsEnvelope,
} from "@/lib/insights-envelope-api";

const readEnvelope = makeFunctionReference<
  "action",
  { suiteRunId: string },
  InsightsEnvelope | null
>(INSIGHTS_ENVELOPE_READS.evalRun);

/** Subscribe to small run metadata, then rebuild the file-backed view on change. */
export function useEvalInsightsEnvelope(suiteRunId: string | null | undefined) {
  const run = useQuery(
    "testSuites:getTestSuiteRun" as never,
    suiteRunId ? ({ runId: suiteRunId } as never) : "skip",
  );
  const read = useAction(readEnvelope);
  const [loaded, setLoaded] = useState<{
    run: unknown;
    id: string;
    value: InsightsEnvelope | null;
  } | null>(null);
  useEffect(() => {
    if (!suiteRunId || run === undefined) return;
    let active = true;
    void read({ suiteRunId }).then(
      (value) => {
        if (active) setLoaded({ run, id: suiteRunId, value });
      },
      (error) => {
        // The run remains readable when its archived evidence is unavailable.
        console.debug("Eval insights envelope unavailable", error);
        if (active) setLoaded({ run, id: suiteRunId, value: null });
      },
    );
    return () => {
      active = false;
    };
  }, [suiteRunId, run, read]);
  return loaded && loaded.id === suiteRunId && loaded.run === run
    ? loaded.value
    : undefined;
}
