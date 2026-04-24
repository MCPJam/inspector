import { useConvex } from "convex/react";
import { useEffect, useState } from "react";
import type {
  EvalCase,
  EvalIteration,
  SuiteDetailsQueryResponse,
} from "./types";

export type PlaygroundWorkspaceExecutionsStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export function usePlaygroundWorkspaceExecutions({
  enabled,
  suiteIds,
}: {
  enabled: boolean;
  suiteIds: readonly string[];
}) {
  const convex = useConvex();
  const suiteIdsFingerprint = [...suiteIds].sort().join("\0");

  const [status, setStatus] = useState<PlaygroundWorkspaceExecutionsStatus>(
    "idle",
  );
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [iterations, setIterations] = useState<EvalIteration[]>([]);
  const [iterationToSuiteId, setIterationToSuiteId] = useState<
    Map<string, string>
  >(() => new Map());

  useEffect(() => {
    if (!enabled || suiteIds.length === 0) {
      setStatus("idle");
      setCases([]);
      setIterations([]);
      setIterationToSuiteId(new Map());
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setCases([]);
    setIterations([]);
    setIterationToSuiteId(new Map());

    const orderedSuiteIds = [...suiteIds].sort();

    void (async () => {
      try {
        const results = await Promise.all(
          orderedSuiteIds.map((suiteId) =>
            convex.query(
              "testSuites:getAllTestCasesAndIterationsBySuite" as any,
              { suiteId } as any,
            ) as Promise<SuiteDetailsQueryResponse | undefined>,
          ),
        );

        if (cancelled) {
          return;
        }

        const mergedCases: EvalCase[] = [];
        const mergedIterations: EvalIteration[] = [];
        const iterSuite = new Map<string, string>();
        const seenCase = new Set<string>();
        const seenIter = new Set<string>();

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const suiteId = orderedSuiteIds[i];
          if (!r) {
            continue;
          }

          for (const c of r.testCases ?? []) {
            if (!seenCase.has(c._id)) {
              seenCase.add(c._id);
              mergedCases.push(c);
            }
          }
          for (const iter of r.iterations ?? []) {
            if (iter._id && !seenIter.has(iter._id)) {
              seenIter.add(iter._id);
              mergedIterations.push(iter);
              iterSuite.set(iter._id, suiteId);
            }
          }
        }

        setCases(mergedCases);
        setIterations(mergedIterations);
        setIterationToSuiteId(iterSuite);
        setStatus("ready");
      } catch {
        if (!cancelled) {
          setStatus("error");
          setCases([]);
          setIterations([]);
          setIterationToSuiteId(new Map());
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // `useConvex()` may return a new object each render; the client is stable.
  }, [enabled, suiteIdsFingerprint]);

  return {
    status,
    cases,
    iterations,
    iterationToSuiteId,
  };
}
