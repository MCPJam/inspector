import { getUserErrorMessage } from "@/lib/user-error";
/**
 * The findings controller: ONE subscription, ONE generation controller.
 *
 * It deliberately does NOT mount its own `useServerQuality`. The Evaluate run
 * page already has one, and a second instance would mean two lifecycles
 * watching the same run, two first-view claims and — on a click — two billable
 * requests. So the caller passes its existing controller in and this hook only
 * decides which mode to ask for.
 *
 * Two operations with separate lifecycles: BUILD (free, deterministic; runs on
 * the terminal path and on request) and ENRICH (metered; the trace pipeline,
 * requested through the page's serverQuality controller in `findings` mode).
 * ANALYZE composes them: build if there is no usable snapshot, then enrich
 * once the subscription reports the new one. Nothing fires on mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  selectCurrentFindings,
  unifiedFindingsOf,
  type ActionableFinding,
  type InsightsEnvelope,
  type InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";
import type { UnifiedFindingsMode } from "./unified-findings-panel";
import type { FindingsAnalysisAction } from "./unified-findings-panel";

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
  /** `ai` once a current enrichment exists; the deterministic view otherwise. */
  mode: UnifiedFindingsMode;
  findings: ActionableFinding[];
  provenance: InsightsFindingProvenance[];
  analyze: FindingsAnalysisAction;
  analysisFailure: { errorCode?: string } | null;
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
  "The connected backend does not support findings yet. Update the backend to build findings for this run.";

/**
 * Why the enrich button can be dead while the backend serves the experiment.
 *
 * `useInsight`'s `classifyInsightError` folds a daily-limit rejection into
 * `unavailable: true` with no message — its own comment marks that branch
 * DEAD, because the backend raises `billing_limit_reached` / `Limit
 * "insightsPerDay"` and never the string it matches. Repairing that hook is
 * out of this experiment's scope (it is document-keyed and shared with the
 * legacy surface), but leaving the reader with a disabled button and no
 * explanation is not. This names the likely cause without asserting it.
 */
const GENERATION_UNAVAILABLE_NOTE =
  "AI analysis is unavailable right now. Check your workspace’s daily insights limit or try again later.";

export function useUnifiedFindings(args: {
  suiteRunId: string | null | undefined;
  envelope: InsightsEnvelope | null | undefined;
  /** The page's EXISTING serverQuality controller. Never a second one. */
  generation: BorrowedGenerationController;
}): UnifiedFindingsState {
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
  const [awaitingBuild, setAwaitingBuild] = useState(false);
  const analysisInFlight = useRef(false);
  const analysisBuildStamp = useRef<number | null>(null);
  const analysisPreviousJob = useRef<number | null>(null);

  /**
   * The same guard for the ENRICH path, which needs it more.
   *
   * `enrich.pending` is the borrowed controller's document-backed value, so it
   * stays false until the run subscription reports the job. Two clicks inside
   * that window both reach `requestInsight`, and unlike a build that is a
   * METERED provider call. The ref blocks the second one synchronously; the
   * state beside it is what the button disables from.
   */
  const enrichInFlight = useRef(false);
  const [enrichRequested, setEnrichRequested] = useState(false);
  /** The controller's error as it stood at the click, so a request that fails
   *  without ever going pending still hands authority back. */
  const enrichErrorAtRequest = useRef<string | null>(null);
  const enrichmentAtRequest = useRef<number | null>(null);
  /**
   * Monotonic build token, because the run id alone has an ABA hole.
   *
   * Select run A, then B, then A again: a callback from the FIRST A request
   * still matches `boundRunIdRef`, so it would clear the second A request's
   * pending flag or overwrite its error. The token only ever moves forward,
   * so a stale callback can never match a live one.
   */
  const buildToken = useRef(0);
  /**
   * Whether an enrichment was requested for THIS run, in this session.
   *
   * The generation controller is shared with the legacy panel, so its
   * `failedGeneration` is true for a run whose LEGACY analysis failed long
   * before this section existed. Announcing "the AI explanation failed" for
   * that is a misattribution — nobody asked this section for one.
   */
  const [enrichAttempted, setEnrichAttempted] = useState(false);

  const buildMutation = useMutation(BUILD_FINDINGS_MUTATION as never);
  const experiment = unifiedFindingsOf(args.envelope);

  /**
   * Every piece of state above is scoped to ONE run.
   *
   * `EvaluateRunContent` is not keyed by run id, so selecting a different run
   * re-renders this same hook instance. Without this, run A's build error
   * stays on screen for run B, and an `ai` mode selection survives onto a run
   * that has no enrichment at all. Adjusting during render is React's
   * documented way to do this: it re-renders before committing, so the stale
   * values are never painted.
   */
  const runId = args.suiteRunId ?? null;
  const [boundRunId, setBoundRunId] = useState<string | null>(runId);
  /** The bound run, readable synchronously from an async callback. */
  const boundRunIdRef = useRef<string | null>(runId);
  if (boundRunId !== runId) {
    buildToken.current += 1;
    boundRunIdRef.current = runId;
    setBoundRunId(runId);
    setBuildError(null);
    setBuildRequested(false);
    buildInFlight.current = false;
    enrichInFlight.current = false;
    setEnrichRequested(false);
    setEnrichAttempted(false);
    setAwaitingBuild(false);
    analysisInFlight.current = false;
  }

  useEffect(() => {
    if (!enrichRequested) return;
    // The document has spoken — either it reports the job, or the request
    // failed outright. Either way the optimistic flag has done its work.
    if (
      args.generation.pending ||
      args.generation.error !== enrichErrorAtRequest.current
    ) {
      enrichInFlight.current = false;
      setEnrichRequested(false);
    }
  }, [enrichRequested, args.generation.pending, args.generation.error]);

  const onBuild = useCallback(() => {
    if (!args.suiteRunId) return;
    // The run this request belongs to. A rejection that settles after the
    // reader has moved on must not write its error onto another run.
    const requestedFor = args.suiteRunId;
    // A second click while one is in flight must not become a second job. The
    // backend refuses it anyway (the claim is the real guard); this only keeps
    // the UI from asking.
    //
    // This guard runs BEFORE the token is taken, and the order matters: a
    // blocked click that still bumped the token would make the LIVE request
    // stale, its `finally` would skip the cleanup, and the button would stay
    // disabled for the rest of the run's life. Only a request that is really
    // starting gets to move the token.
    if (buildInFlight.current || experiment?.job?.status === "pending") return;
    const token = (buildToken.current += 1);
    const stale = () =>
      boundRunIdRef.current !== requestedFor || buildToken.current !== token;
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
        if (stale()) return;
        setBuildError(getUserErrorMessage(error));
        setAwaitingBuild(false);
        analysisInFlight.current = false;
      })
      .finally(() => {
        if (stale()) return;
        buildInFlight.current = false;
        setBuildRequested(false);
      });
  }, [
    args.suiteRunId,
    buildMutation,
    experiment?.job?.status,
    experiment?.snapshot,
  ]);

  const mode: UnifiedFindingsMode =
    experiment?.snapshot?.enrichment?.status === "ready"
      ? "ai"
      : "deterministic";

  // The branch `onAnalyze` takes: a snapshot that is not stale can only be
  // enriched, anything else has to be built first. Availability follows the
  // same split so an enabled button never lands on a silent return.
  const analyzeCapable =
    experiment?.snapshot && experiment.snapshot.enrichment?.status !== "stale"
      ? experiment.canEnrich === true
      : experiment?.canBuild === true;

  // A new enrichment landed for the run this section asked about: the
  // request is settled whether or not `pending` was ever observed.
  useEffect(() => {
    const result = experiment?.snapshot?.enrichment;
    if (
      enrichAttempted &&
      result?.status === "ready" &&
      result.generatedAt !== enrichmentAtRequest.current
    ) {
      setEnrichAttempted(false);
      setEnrichRequested(false);
      enrichInFlight.current = false;
    }
  }, [enrichAttempted, experiment?.snapshot?.enrichment]);

  const onEnrich = useCallback(() => {
    if (enrichInFlight.current || args.generation.pending) return;
    enrichInFlight.current = true;
    enrichmentAtRequest.current =
      experiment?.snapshot?.enrichment?.generatedAt ?? null;
    enrichErrorAtRequest.current = args.generation.error;
    setEnrichRequested(true);
    setEnrichAttempted(true);
    // The existing controller, in findings mode. `force: true` because
    // a run that already has a legacy serverQuality result would otherwise be
    // refused as "already completed" — the metering and the job-id guard are
    // unchanged either way.
    args.generation.requestInsight(true, { mode: "findings" });
  }, [args.generation, experiment?.snapshot?.enrichment?.generatedAt]);

  // A single explicit click can prepare missing/stale evidence, then request
  // AI once the subscription confirms the new snapshot. Never runs on mount.
  const onAnalyze = useCallback(() => {
    if (
      analysisInFlight.current ||
      buildInFlight.current ||
      enrichInFlight.current ||
      args.generation.pending ||
      experiment?.job?.status === "pending" ||
      args.generation.unavailable ||
      !args.generation.canRequest
    )
      return;
    if (
      experiment?.snapshot &&
      experiment.snapshot.enrichment?.status !== "stale"
    ) {
      if (experiment.canEnrich) onEnrich();
      return;
    }
    if (!experiment?.canBuild) return;
    analysisInFlight.current = true;
    analysisBuildStamp.current = experiment.snapshot?.builtAt ?? null;
    analysisPreviousJob.current = experiment.job?.updatedAt ?? null;
    setAwaitingBuild(true);
    onBuild();
  }, [args.generation, experiment, onBuild, onEnrich]);

  useEffect(() => {
    if (!awaitingBuild) return;
    if (
      experiment?.job?.status === "failed" &&
      experiment.job.updatedAt !== analysisPreviousJob.current
    ) {
      setAwaitingBuild(false);
      analysisInFlight.current = false;
      return;
    }
    if (
      !experiment?.snapshot ||
      experiment.snapshot.builtAt === analysisBuildStamp.current ||
      !experiment.canEnrich ||
      experiment.job?.status === "pending"
    )
      return;
    setAwaitingBuild(false);
    analysisInFlight.current = false;
    if (!args.generation.unavailable && args.generation.canRequest) onEnrich();
  }, [
    awaitingBuild,
    experiment,
    args.generation.unavailable,
    args.generation.canRequest,
    onEnrich,
  ]);

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
      : // The backend serves findings, yet the borrowed controller says
      // no. Without this the button is simply dead and the reader is
      // told nothing at all.
      args.generation.unavailable
      ? GENERATION_UNAVAILABLE_NOTE
      : null;

  const analyzePending =
    awaitingBuild ||
    buildRequested ||
    jobPending ||
    enrichRequested ||
    args.generation.pending;
  const enrichment = experiment?.snapshot?.enrichment;
  const job = experiment?.job;
  const analysisFailure =
    job?.kind === "enrich" &&
    job.status === "failed" &&
    !analyzePending &&
    !(enrichment && enrichment.generatedAt >= job.startedAt)
      ? {
          ...(job.errorCode && job.errorCode !== "cancelled"
            ? { errorCode: job.errorCode }
            : {}),
        }
      : null;

  return {
    envelope: args.envelope,
    experiment,
    mode,
    findings,
    provenance,
    analysisFailure,
    analyze: {
      available:
        analyzeCapable &&
        experiment?.job?.status !== "pending" &&
        !args.generation.unavailable &&
        args.generation.canRequest,
      pending: analyzePending,
      error:
        buildError ??
        (jobFailed
          ? experiment?.job?.errorMessage ??
            experiment?.job?.errorCode ??
            "Evidence could not be prepared."
          : null) ??
        (enrichAttempted
          ? args.generation.error ??
            (args.generation.failedGeneration
              ? "AI analysis did not complete."
              : null)
          : null),
      onRun: onAnalyze,
    },
    build: {
      available: experiment?.canBuild === true,
      pending: buildRequested || jobPending,
      error:
        buildError ??
        (jobFailed
          ? experiment?.job?.errorMessage ??
            experiment?.job?.errorCode ??
            "The build failed."
          : null),
      onRun: onBuild,
    },
    enrich: {
      available:
        experiment?.canEnrich === true &&
        !args.generation.unavailable &&
        args.generation.canRequest,
      pending: enrichRequested || args.generation.pending,
      // Only this section's OWN attempt is reported here. The generation
      // controller is shared with the legacy panel, so `failedGeneration` is
      // already true for a run whose legacy analysis failed before this
      // section existed — announcing that as "the AI explanation failed"
      // would pin someone else's failure on this snapshot. A reload loses
      // the attempt flag, and that is the honest outcome: from the client
      // the two failures are indistinguishable, so this says nothing rather
      // than guessing which one it was.
      error: enrichAttempted
        ? args.generation.failedGeneration
          ? args.generation.error ??
            "The AI explanation did not complete. The observations below are unaffected."
          : args.generation.error
        : null,
      onRun: onEnrich,
    },
    backendUnavailableNote,
  };
}
