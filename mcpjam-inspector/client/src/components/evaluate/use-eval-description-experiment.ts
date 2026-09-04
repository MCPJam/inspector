/**
 * One description-experiment read for a source run.
 *
 * Keyed on the source run and the decision revision: a judge landing after
 * the run terminalized is a different reading of the same run, and an
 * experiment attached to the earlier decision must not paint over the new
 * one. Polls every 5 s while status is non-terminal
 * (`proposing` | `launching` | `running` | `reporting`) and stops at
 * `proposed` | `completed` | `failed` | `cancelled`.
 *
 * The first read is the collection GET for the source run (latest
 * experiment). After propose / start, polling is GET-by-id. Flag-off
 * callers pass `enabled: false` so this issues zero requests.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchEvalDescriptionExperiment,
  isDescriptionExperimentNonTerminal,
  isEvalDescriptionExperimentError,
  listEvalDescriptionExperimentsForRun,
  proposeEvalDescriptionRewrite,
  startEvalDescriptionExperiment,
  type DescriptionExperimentFailureKind,
  type EvalDescriptionExperiment,
} from "@/lib/apis/eval-description-experiment-api";

export const DESCRIPTION_EXPERIMENT_POLL_MS = 5_000;

export interface DescriptionExperimentErrorInfo {
  message: string;
  kind: DescriptionExperimentFailureKind;
  status?: number;
}

export type EvalDescriptionExperimentReadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "absent"
  | "error";

export interface EvalDescriptionExperimentState {
  status: EvalDescriptionExperimentReadStatus;
  experiment: EvalDescriptionExperiment | null;
  error: DescriptionExperimentErrorInfo | null;
  propose: (input: { toolName: string; caseIds?: string[] }) => Promise<void>;
  start: (input?: {
    caseScope?: "all" | "affected";
    iterationOverride?: number;
    maxTrials?: number;
  }) => Promise<void>;
  refetch: () => void;
}

function toErrorInfo(error: unknown): DescriptionExperimentErrorInfo {
  if (isEvalDescriptionExperimentError(error)) {
    return {
      message: error.message,
      kind: error.kind,
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    kind: "requestFailed",
  };
}

function pickLatest(
  rows: readonly EvalDescriptionExperiment[],
): EvalDescriptionExperiment | null {
  if (rows.length === 0) return null;
  return rows[rows.length - 1] ?? null;
}

export function useEvalDescriptionExperiment({
  projectId,
  sourceRunId,
  revision,
  enabled = true,
}: {
  projectId: string | null | undefined;
  sourceRunId: string | null | undefined;
  /** Decision revision of the source run. Changing it restarts the read. */
  revision: string;
  enabled?: boolean;
}): EvalDescriptionExperimentState {
  const active = Boolean(enabled && projectId && sourceRunId);
  const key = active ? `${projectId}:${sourceRunId}:${revision}` : "";

  const [experiment, setExperiment] = useState<EvalDescriptionExperiment | null>(
    null,
  );
  const [status, setStatus] = useState<EvalDescriptionExperimentReadStatus>(
    "idle",
  );
  const [error, setError] = useState<DescriptionExperimentErrorInfo | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);

  const requestIdRef = useRef(0);
  const experimentIdRef = useRef<string | null>(null);
  const lastKeyRef = useRef(key);

  useEffect(() => {
    if (!active) {
      requestIdRef.current += 1;
      experimentIdRef.current = null;
      lastKeyRef.current = key;
      setStatus("idle");
      setExperiment(null);
      setError(null);
      return;
    }

    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      experimentIdRef.current = null;
      setExperiment(null);
    }

    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const controller = new AbortController();
    setStatus("loading");
    setError(null);

    const knownId = experimentIdRef.current;

    void (async () => {
      try {
        let next: EvalDescriptionExperiment | null;
        if (knownId) {
          next = await fetchEvalDescriptionExperiment(
            { projectId: projectId as string, experimentId: knownId },
            controller.signal,
          );
        } else {
          const rows = await listEvalDescriptionExperimentsForRun(
            { projectId: projectId as string, runId: sourceRunId as string },
            controller.signal,
          );
          next = pickLatest(rows);
        }
        if (requestId !== requestIdRef.current) return;
        if (!next) {
          experimentIdRef.current = null;
          setExperiment(null);
          setStatus("absent");
          return;
        }
        experimentIdRef.current = next.id;
        setExperiment(next);
        setStatus("ready");
      } catch (err) {
        if (controller.signal.aborted) return;
        if (requestId !== requestIdRef.current) return;
        const info = toErrorInfo(err);
        if (info.kind === "notFound" || info.kind === "routeUnavailable") {
          if (!experimentIdRef.current) {
            setExperiment(null);
            setError(null);
            setStatus("absent");
            return;
          }
        }
        setError(info);
        setStatus("error");
      }
    })();

    return () => controller.abort();
  }, [active, key, attempt, projectId, sourceRunId]);

  useEffect(() => {
    if (!active || !experiment) return;
    if (!isDescriptionExperimentNonTerminal(experiment.status)) return;
    if (!projectId) return;

    const requestId = requestIdRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await fetchEvalDescriptionExperiment(
            { projectId, experimentId: experiment.id },
            controller.signal,
          );
          if (requestId !== requestIdRef.current) return;
          experimentIdRef.current = next.id;
          setExperiment(next);
          setStatus("ready");
          setError(null);
        } catch (err) {
          if (controller.signal.aborted) return;
          if (requestId !== requestIdRef.current) return;
          const info = toErrorInfo(err);
          if (info.kind === "notFound") {
            setError(null);
            setStatus("absent");
            setExperiment(null);
            experimentIdRef.current = null;
            return;
          }
          setError(info);
          setStatus("error");
        }
      })();
    }, DESCRIPTION_EXPERIMENT_POLL_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, experiment, projectId]);

  const propose = useCallback(
    async (input: { toolName: string; caseIds?: string[] }) => {
      if (!active || !projectId || !sourceRunId) return;
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      setStatus("loading");
      setError(null);
      try {
        const next = await proposeEvalDescriptionRewrite({
          projectId,
          runId: sourceRunId,
          toolName: input.toolName,
          ...(input.caseIds ? { caseIds: input.caseIds } : {}),
        });
        if (requestId !== requestIdRef.current) return;
        experimentIdRef.current = next.id;
        setExperiment(next);
        setStatus("ready");
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(toErrorInfo(err));
        setStatus("error");
      }
    },
    [active, projectId, sourceRunId],
  );

  const start = useCallback(
    async (input?: {
      caseScope?: "all" | "affected";
      iterationOverride?: number;
      maxTrials?: number;
    }) => {
      const id = experimentIdRef.current ?? experiment?.id;
      if (!active || !projectId || !id) return;
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      setStatus("loading");
      setError(null);
      try {
        const next = await startEvalDescriptionExperiment({
          projectId,
          experimentId: id,
          ...(input?.caseScope !== undefined
            ? { caseScope: input.caseScope }
            : {}),
          ...(input?.iterationOverride !== undefined
            ? { iterationOverride: input.iterationOverride }
            : {}),
          ...(input?.maxTrials !== undefined
            ? { maxTrials: input.maxTrials }
            : {}),
        });
        if (requestId !== requestIdRef.current) return;
        experimentIdRef.current = next.id;
        setExperiment(next);
        setStatus("ready");
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(toErrorInfo(err));
        setStatus("error");
      }
    },
    [active, projectId, experiment?.id],
  );

  const refetch = useCallback(() => {
    if (!active) return;
    setAttempt((n) => n + 1);
  }, [active]);

  const observed: EvalDescriptionExperimentReadStatus =
    active && status === "idle" ? "loading" : status;

  return {
    status: observed,
    experiment,
    error,
    propose,
    start,
    refetch,
  };
}
