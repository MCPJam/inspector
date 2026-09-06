import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import type { SuiteFailureGroupsQueryResult } from "@/components/evaluate/failure-groups-model";

type RequestState = {
  /** The suite the request was made for; state for any other suite is hidden. */
  suiteId: string;
  requesting: boolean;
  error: string | null;
};

/**
 * Latest completed failure-groups row for a suite, plus an in-flight request.
 *
 * Typed loosely: the Convex generated API for `evalFailureGroups` lives in
 * the backend repo and may not be deployed yet. Same `as any` + `"skip"`
 * pattern as {@link useEvalQueries}.
 *
 * `requesting` and `error` belong to the suite they were produced for. A
 * switch to another suite shows neither, and a request that settles after
 * the switch — or after a newer request — is ignored rather than written
 * over the current suite's state.
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

  const [requestState, setRequestState] = useState<RequestState | null>(null);
  // Sequence of the newest request. A completion carrying an older number
  // is stale: a later request superseded it, or the suite changed. A suite
  // change also drops the old suite's state outright, so a request that was
  // still out when the reader left cannot come back as "requesting" with it.
  const sequenceRef = useRef(0);
  useEffect(() => {
    sequenceRef.current += 1;
    setRequestState((state) =>
      state && state.suiteId !== suiteId ? null : state,
    );
  }, [suiteId]);

  const request = useCallback(async () => {
    if (!active || !suiteId) return;
    const sequence = ++sequenceRef.current;
    setRequestState({ suiteId, requesting: true, error: null });
    try {
      await requestMut({ suiteId } as any);
      if (sequence !== sequenceRef.current) return;
      setRequestState({ suiteId, requesting: false, error: null });
    } catch (err) {
      if (sequence !== sequenceRef.current) return;
      setRequestState({
        suiteId,
        requesting: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [active, suiteId, requestMut]);

  const current =
    requestState && requestState.suiteId === suiteId ? requestState : null;

  return {
    latest: result?.latest ?? null,
    inFlight: result?.inFlight ?? null,
    loading: active && result === undefined,
    requesting: current?.requesting ?? false,
    error: current?.error ?? null,
    request,
  };
}
