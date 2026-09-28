/**
 * One read of "what changed since the previous run", for the run page.
 *
 * No store and no LRU, unlike the decision summary: this is one request per
 * page view, the answer is not shared with another surface, and a cache would
 * be more machinery than the read is worth.
 *
 * Keyed on the run's REVISION rather than its id alone, for the same reason the
 * chain reads are: a judge landing after the run terminalized changes what the
 * comparison says, and serving the earlier answer would show a diff that no
 * longer matches the verdict beside it.
 */
import { useCallback, useEffect, useState } from "react";

import {
  fetchEvalRunCompare,
  isEvalRunCompareError,
  type EvalRunCompareDto,
  type EvalRunCompareFailureKind,
} from "@/lib/apis/eval-run-compare-api";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import type { EvalSuiteRun } from "../evals/types";

export type EvalRunCompareState = {
  status: "disabled" | "loading" | "ready" | "error";
  dto: EvalRunCompareDto | null;
  /** Which failure, when there was one. `noBaseline` is not an error to show. */
  errorKind: EvalRunCompareFailureKind | null;
};

const DISABLED: EvalRunCompareState = {
  status: "disabled",
  dto: null,
  errorKind: null,
};

export function useEvalRunCompare({
  projectId,
  run,
  baseRunId,
  enabled,
}: {
  projectId: string | null | undefined;
  run: EvalSuiteRun | null;
  /** The run to compare against. Omitted lets the server pick the previous. */
  baseRunId?: string | null;
  enabled: boolean;
}): EvalRunCompareState {
  const terminal = isTerminalEvalRunStatus(run?.status);
  const active = Boolean(enabled && projectId && run && terminal);
  const revision = run ? evalRunDecisionRevision(run) : "";
  const key = active
    ? `${projectId}:${run?._id}:${baseRunId ?? ""}:${revision}`
    : "";

  const [state, setState] = useState<EvalRunCompareState>(DISABLED);

  const load = useCallback(
    (signal: AbortSignal) => {
      if (!active || !projectId || !run) {
        setState(DISABLED);
        return;
      }
      setState({ status: "loading", dto: null, errorKind: null });
      void fetchEvalRunCompare(
        {
          projectId,
          runId: run._id,
          ...(baseRunId ? { baseRunId } : {}),
        },
        signal,
      )
        .then((dto) => {
          if (signal.aborted) return;
          setState({ status: "ready", dto, errorKind: null });
        })
        .catch((error) => {
          if (signal.aborted) return;
          setState({
            status: "error",
            dto: null,
            errorKind: isEvalRunCompareError(error)
              ? error.kind
              : "requestFailed",
          });
        });
    },
    // `key` stands in for the identity of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    if (!key) {
      setState(DISABLED);
      return;
    }
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [key, load]);

  return state;
}
