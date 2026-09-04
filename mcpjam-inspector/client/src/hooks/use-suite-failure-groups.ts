import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import type { SuiteFailureGroupsQueryResult } from "@/components/evaluate/failure-groups-model";

/**
 * Latest completed failure-groups row for a suite, plus an in-flight request.
 *
 * Typed loosely: the Convex generated API for `evalFailureGroups` lives in
 * the backend repo and may not be deployed yet. Same `as any` + `"skip"`
 * pattern as {@link useEvalQueries}.
 */
export function useSuiteFailureGroups({
  suiteId,
  enabled,
}: {
  suiteId: string | null | undefined;
  enabled: boolean;
}): {
  latest: SuiteFailureGroupsQueryResult["latest"];
  inFlight: SuiteFailureGroupsQueryResult["inFlight"];
  loading: boolean;
  requesting: boolean;
  error: string | null;
  request: () => Promise<void>;
} {
  const active = enabled && !!suiteId;
  const result = useQuery(
    "evalFailureGroups:getSuiteFailureGroups" as any,
    active ? ({ suiteId } as any) : "skip",
  ) as SuiteFailureGroupsQueryResult | null | undefined;

  const requestMut = useMutation(
    "evalFailureGroups:requestSuiteFailureGroups" as any,
  );

  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(async () => {
    if (!active || !suiteId) return;
    setRequesting(true);
    setError(null);
    try {
      await requestMut({ suiteId } as any);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequesting(false);
    }
  }, [active, suiteId, requestMut]);

  return {
    latest: result?.latest ?? null,
    inFlight: result?.inFlight ?? null,
    loading: active && result === undefined,
    requesting,
    error,
    request,
  };
}
