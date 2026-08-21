/**
 * Generic insight hook — shared lifecycle for any AI-generated insight
 * stored on an eval suite run (run insights, failure analysis, etc.).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type { EvalSuiteRun } from "./types";

export type InsightStatus = "pending" | "completed" | "failed" | undefined;

export interface InsightConfig<TResult> {
  /** Read the insight status from the run document. */
  getStatus: (run: EvalSuiteRun) => InsightStatus;
  /** Read the insight result from the run document. */
  getResult: (run: EvalSuiteRun) => TResult | undefined;
  /** Convex mutation path for requesting generation, e.g. "runInsights:requestRunInsights". */
  requestMutation: string;
  /** Convex mutation path for cancelling generation, e.g. "runInsights:cancelRunInsights". */
  cancelMutation: string;
}

export interface InsightHookResult<TResult> {
  canRequest: boolean;
  error: string | null;
  /** User-facing message for a REQUEST-TIME rejection (e.g. spend-cap). */
  errorMessage: string | null;
  unavailable: boolean;
  requested: boolean;
  pending: boolean;
  failedGeneration: boolean;
  result: TResult | undefined;
  summary: string | null;
  requestInsight: (
    force?: boolean,
    extraArgs?: Record<string, unknown>,
  ) => void;
  cancelInsight: () => void;
}

/** Result freshness marker shared by every insight payload. */
function resultGeneratedAt(result: unknown): number | undefined {
  return (result as { generatedAt?: number } | undefined)?.generatedAt;
}

/**
 * First-view auto-request claims, shared by every hook instance in the tab.
 *
 * `hasAutoAttemptedRef` below is per-instance, which is why three components
 * observing the same run — the suite insights band, the run detail pane and
 * the test-case detail — each fired their own first-view request for it. All
 * of them read `status === undefined` in the same tick, so all of them
 * requested; the backend granted the first and the rest lost the race (Sentry
 * CONVEX-AR). Whoever wins flips the status the others are watching, so one
 * request is all the surfaces ever needed.
 *
 * Keyed by mutation as well as run, so run insights and server quality never
 * block each other. Claims are released when a request FAILS, so a transient
 * error doesn't disable first-view generation for that run for the rest of the
 * session; a successful claim is kept, which costs nothing — the status it
 * just moved off `undefined` is what the auto-request effect gates on anyway.
 */
const autoRequestClaims = new Set<string>();

function autoRequestKey(mutation: string, runId: string): string {
  return `${mutation}::${runId}`;
}

/** Returns true when THIS caller is the one that should issue the request. */
function claimAutoRequest(mutation: string, runId: string): boolean {
  const key = autoRequestKey(mutation, runId);
  if (autoRequestClaims.has(key)) {
    return false;
  }
  autoRequestClaims.add(key);
  return true;
}

function releaseAutoRequest(mutation: string, runId: string): void {
  autoRequestClaims.delete(autoRequestKey(mutation, runId));
}

/** Test-only: drops every claim so cases don't leak state into each other. */
export function __resetAutoRequestClaims(): void {
  autoRequestClaims.clear();
}

function classifyInsightError(err: unknown): {
  unavailable: boolean;
  permanent: boolean;
  message: string;
} {
  const raw = err instanceof Error ? err.message : String(err);

  // Known structured rejections short-circuit ahead of the generic
  // unavailable/permanent classification. Convex wraps mutation rejections
  // with a "Server Error" prefix, so a spend-cap rejection would otherwise
  // be misclassified as `unavailable: true` and the calling component
  // hides the surface entirely (SuiteInsightsCollapsible returns null on
  // unavailable). These are *rejections*, not unavailability — the
  // feature works, the user is rate-limited / quota-bound.
  // DEAD as written: the backend raises `billing_limit_reached` /
  // `Limit "insightsPerDay"` from the entitlement helper, never this string,
  // so an eval-surface cap currently falls through to the generic branch
  // below and hides the band instead of explaining itself. Left in place
  // rather than fixed here — this hook is document-keyed (it reads lifecycle
  // off the `EvalSuiteRun` row with no subscription of its own) and pinned by
  // its own suite, so it is deliberately NOT merged into `use-run-insights`.
  // `classifyRunInsightError` there matches the strings the backend really
  // emits, and is the reference when this one is repaired.
  if (raw.includes("insights_daily_limit_reached")) {
    return {
      unavailable: false,
      permanent: false,
      message:
        "Daily insights limit reached for your workspace. Try again tomorrow or upgrade.",
    };
  }

  // "Feature missing" — the backend mutation isn't deployed at all. This is
  // permanent for the session: a Convex function-lookup failure won't change
  // between runs, so the panel should stay hidden without re-attempting.
  const permanent =
    raw.includes("Could not find") || raw.includes("is not a function");
  const unavailable =
    permanent ||
    raw.includes("not found") || // run-specific, e.g. "Suite run not found"
    raw.includes("Server Error");
  return { unavailable, permanent, message: raw };
}

export function useInsight<TResult extends { summary?: string }>(
  run: EvalSuiteRun | null,
  config: InsightConfig<TResult>,
  options?: { autoRequest?: boolean },
): InsightHookResult<TResult> {
  const autoRequest = options?.autoRequest !== false;
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [requested, setRequested] = useState(false);
  const hasAutoAttemptedRef = useRef(false);
  const runIdRef = useRef<string | null>(null);
  // True only when the backend feature itself is missing (mutation not
  // deployed). Unlike a run-specific/transient failure, this is permanent for
  // the hook's lifetime, so we keep `unavailable` sticky across run switches
  // rather than re-attempting (and flashing the panel) on every navigation.
  const featureMissingRef = useRef(false);
  // The result `generatedAt` captured at request time. Lets us clear the
  // optimistic `requested` flag the instant a NEW result lands — even when a
  // reactive update skips an observable `pending` frame — so the controls
  // never stay stuck disabled.
  const latestResultStampRef = useRef<number | undefined>(undefined);
  const requestedAtStampRef = useRef<number | undefined>(undefined);

  const requestMut = useMutation(config.requestMutation as any);
  const cancelMut = useMutation(config.cancelMutation as any);

  const status = run ? config.getStatus(run) : undefined;
  const result = run ? config.getResult(run) : undefined;
  latestResultStampRef.current = resultGeneratedAt(result);

  const canRequest =
    run != null &&
    run.status === "completed" &&
    status !== "pending" &&
    !unavailable;

  const requestInsight = useCallback(
    (
      force?: boolean,
      extraArgs?: Record<string, unknown>,
      // Set only by the auto-request effect below, which holds the shared
      // first-view claim for this run and needs it released if the request
      // never lands. Not part of the public `InsightHookResult` signature.
      autoClaimedRunId?: string,
    ) => {
      if (!run || unavailable) {
        return;
      }
      setError(null);
      requestedAtStampRef.current = latestResultStampRef.current;
      setRequested(true);
      requestMut({ suiteRunId: run._id, force, ...extraArgs } as any).catch(
        (err: unknown) => {
          if (autoClaimedRunId) {
            releaseAutoRequest(config.requestMutation, autoClaimedRunId);
          }
          setRequested(false);
          const classified = classifyInsightError(err);
          if (classified.unavailable) {
            if (classified.permanent) {
              featureMissingRef.current = true;
            }
            setUnavailable(true);
          } else {
            setError(classified.message);
          }
        },
      );
    },
    [run, unavailable, requestMut, config.requestMutation],
  );

  const cancelInsight = useCallback(async () => {
    if (!run || unavailable) {
      return;
    }
    await cancelMut({ suiteRunId: run._id } as any);
  }, [run, unavailable, cancelMut]);

  // Reset state when the run changes.
  const runKey = run?._id ?? "";
  useEffect(() => {
    if (runIdRef.current !== runKey) {
      runIdRef.current = runKey;
      setError(null);
      setRequested(false);
      // Re-assess availability per run for run-specific/transient failures
      // (e.g. "Suite run not found") so one bad run doesn't hide the panel for
      // every later run — but keep it sticky when the backend feature is
      // genuinely missing, so an autoRequest consumer (serverQuality) doesn't
      // re-fire a failing request and flash the panel on every navigation.
      if (!featureMissingRef.current) {
        setUnavailable(false);
      }
      hasAutoAttemptedRef.current = false;
      requestedAtStampRef.current = undefined;
    }
  }, [runKey]);

  // Clear the optimistic "requested" flag once the job has demonstrably
  // progressed — but NOT in the click→`pending` gap where a stale terminal
  // result still lingers (clearing there would re-enable a re-run/retry trigger
  // and allow a duplicate request). Progress is either:
  //   - status flips to `pending` (job started); or
  //   - a fresh result lands — its `generatedAt` advances past the value
  //     captured at request time.
  // Both completion AND failure write a fresh `generatedAt` (the failed
  // fallback in each *Action's catch stamps Date.now()), so a re-run that ends
  // in failure clears here too; the request mutation's catch covers a request
  // that errors before it ever starts.
  useEffect(() => {
    if (
      status === "pending" ||
      resultGeneratedAt(result) !== requestedAtStampRef.current
    ) {
      setRequested(false);
    }
  }, [status, result, run?._id]);

  // Auto-request on first view of a completed run with no insight.
  useEffect(() => {
    if (!autoRequest) {
      return;
    }
    if (!run || unavailable || hasAutoAttemptedRef.current) {
      return;
    }
    if (run.status !== "completed") {
      return;
    }
    if (status === "pending" || status === "completed" || status === "failed") {
      return;
    }

    hasAutoAttemptedRef.current = true;

    // Another mounted component already owns the first-view request for this
    // run. Firing ours would only race it: the backend hands the job to one
    // caller, and the losers used to surface the rejection as "feature
    // unavailable" — hiding the insight surface on the run just opened, while
    // generation ran fine underneath.
    if (!claimAutoRequest(config.requestMutation, run._id)) {
      return;
    }

    requestInsight(false, undefined, run._id);
  }, [
    autoRequest,
    run,
    status,
    run?.status,
    unavailable,
    requestInsight,
    config.requestMutation,
  ]);

  return {
    canRequest,
    error,
    errorMessage: error,
    unavailable,
    requested,
    requestInsight,
    cancelInsight,
    result,
    summary: (result as { summary?: string } | undefined)?.summary ?? null,
    pending: status === "pending",
    failedGeneration: status === "failed",
  };
}
