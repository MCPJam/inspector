/**
 * The experiment's controller: ONE subscription, ONE generation controller.
 *
 * It deliberately does NOT mount its own `useServerQuality`. The Evaluate run
 * page already has one, and a second instance would mean two lifecycles
 * watching the same run, two first-view claims and — on a click — two billable
 * requests. So the caller passes its existing controller in and this hook only
 * decides which mode to ask for.
 *
 * The envelope subscription is the shared `useInsightsEnvelope`, which is the
 * same query the legacy panel reads; mounting both costs one subscription.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  selectCurrentFindings,
  unifiedFindingsOf,
  type ActionableFinding,
  type InsightsEnvelope,
  type InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";
import type { UnifiedFindingsMode } from "./unified-findings-panel";

export const BUILD_FINDINGS_MUTATION = "evalFindings:requestEvalFindingsBuild";

/** The generation controller this hook borrows, rather than creating. */
export type BorrowedGenerationController = {
  pending: boolean;
  failedGeneration: boolean;
  error: string | null;
  unavailable: boolean;
  canRequest: boolean;
  requestInsight: (
    force?: boolean,
    extraArgs?: Record<string, unknown>,
  ) => void;
};

export type UnifiedFindingsState = {
  /** `undefined` while loading; `null` when the backend serves no envelope. */
  envelope: InsightsEnvelope | null | undefined;
  experiment: ReturnType<typeof unifiedFindingsOf>;
  mode: UnifiedFindingsMode;
  setMode: (mode: UnifiedFindingsMode) => void;
  findings: ActionableFinding[];
  provenance: InsightsFindingProvenance[];
  build: {
    available: boolean;
    pending: boolean;
    error: string | null;
    onRun: () => void;
  };
  enrich: {
    available: boolean;
    pending: boolean;
    error: string | null;
    onRun: () => void;
  };
  /** Set when this client has the experiment but the backend does not. */
  backendUnavailableNote: string | null;
};

const BACKEND_MISSING_NOTE =
  "This Inspector has the unified-findings experiment, but the connected backend does not serve it. Deploy the paired backend branch (and set UNIFIED_FINDINGS_EXPERIMENT=1) to build findings for this run.";

const WRITES_DISABLED_NOTE =
  "The connected backend serves the experiment but its write gate is off (UNIFIED_FINDINGS_EXPERIMENT is not set to 1), so findings cannot be built here. Anything already built still reads.";

export function useUnifiedFindings(args: {
  suiteRunId: string | null | undefined;
  envelope: InsightsEnvelope | null | undefined;
  /** The page's EXISTING serverQuality controller. Never a second one. */
  generation: BorrowedGenerationController;
}): UnifiedFindingsState {
  const [mode, setMode] = useState<UnifiedFindingsMode>("deterministic");
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildRequested, setBuildRequested] = useState(false);
  /**
   * The in-flight guard, as a REF and not as the state above.
   *
   * Two clicks in one tick both read the same stale `buildRequested` — React
   * has not re-rendered between them — so a state guard lets the second one
   * through and the user pays for two jobs. The ref is written synchronously,
   * so the second click sees it. The state stays, because it is what the
   * button's spinner renders from.
   */
  const buildInFlight = useRef(false);

  const buildMutation = useMutation(BUILD_FINDINGS_MUTATION as never);
  const experiment = unifiedFindingsOf(args.envelope);

  const onBuild = useCallback(() => {
    if (!args.suiteRunId) return;
    // A second click while one is in flight must not become a second job. The
    // backend refuses it anyway (the claim is the real guard); this only keeps
    // the UI from asking.
    if (buildInFlight.current || experiment?.job?.status === "pending") return;
    buildInFlight.current = true;
    setBuildError(null);
    setBuildRequested(true);
    void (
      buildMutation as unknown as (
        payload: Record<string, unknown>,
      ) => Promise<unknown>
    )({
      suiteRunId: args.suiteRunId,
      ...(experiment?.snapshot ? { force: true } : {}),
    })
      .catch((error: unknown) => {
        setBuildError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        buildInFlight.current = false;
        setBuildRequested(false);
      });
  }, [
    args.suiteRunId,
    buildMutation,
    experiment?.job?.status,
    experiment?.snapshot,
  ]);

  const onEnrich = useCallback(() => {
    // The existing controller, in the experiment's mode. `force: true` because
    // a run that already has a legacy serverQuality result would otherwise be
    // refused as "already completed" — the metering and the job-id guard are
    // unchanged either way.
    args.generation.requestInsight(true, { mode: "findings" });
  }, [args.generation]);

  const findings = useMemo(() => {
    if (!args.envelope || !experiment?.snapshot) return [];
    return mode === "ai"
      ? selectCurrentFindings(args.envelope)
      : experiment.snapshot.deterministicFindings;
  }, [args.envelope, experiment?.snapshot, mode]);

  const provenance = useMemo(
    () => experiment?.snapshot?.provenance ?? [],
    [experiment?.snapshot],
  );

  const jobPending =
    experiment?.job?.kind === "build" && experiment.job.status === "pending";
  const jobFailed =
    experiment?.job?.kind === "build" && experiment.job.status === "failed";

  const backendUnavailableNote =
    args.envelope === undefined || args.envelope === null
      ? null
      : experiment === null
        ? BACKEND_MISSING_NOTE
        : experiment.writesEnabled
          ? null
          : WRITES_DISABLED_NOTE;

  return {
    envelope: args.envelope,
    experiment,
    mode,
    setMode,
    findings,
    provenance,
    build: {
      available: experiment?.canBuild === true,
      pending: buildRequested || jobPending,
      error:
        buildError ??
        (jobFailed
          ? (experiment?.job?.errorMessage ??
            experiment?.job?.errorCode ??
            "The build failed.")
          : null),
      onRun: onBuild,
    },
    enrich: {
      available:
        experiment?.canEnrich === true &&
        !args.generation.unavailable &&
        args.generation.canRequest,
      pending: args.generation.pending,
      error: args.generation.failedGeneration
        ? (args.generation.error ??
          "The AI explanation did not complete. The observations below are unaffected.")
        : args.generation.error,
      onRun: onEnrich,
    },
    backendUnavailableNote,
  };
}
