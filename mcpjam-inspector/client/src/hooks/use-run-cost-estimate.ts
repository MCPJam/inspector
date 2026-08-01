import { useConvex } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SWARM_QUERIES } from "@/lib/swarm-api";

/**
 * Fetch hooks for the pre-run credit estimate.
 *
 * Deliberately NOT a reactive `useQuery` subscription. The suite estimate reads
 * up to a few thousand iteration docs, and a live subscription would re-execute
 * every time a run writes an iteration — i.e. exactly while the user is looking
 * at a running suite. These hooks fetch ONCE when the tooltip opens, re-fetch
 * when the arguments change while it is still open, and drop the subscription
 * entirely when it closes.
 *
 * Out-of-order responses are discarded by request id: rapidly opening, changing
 * models, and re-opening must never paint a stale estimate over a newer one.
 */

export type RunCostEstimateConfidence =
  | "historical"
  | "partial"
  | "heuristic"
  | "unavailable";

export type RunCostEstimateCoverage = "full" | "partial" | "none";

export interface RunCostEstimateLine {
  label: string;
  units: number;
  usdPerUnit: number | null;
  creditsPerUnit: number | null;
  usd: number | null;
  credits: number | null;
  confidence: RunCostEstimateConfidence;
  sampleCount: number;
}

export interface RunCostEstimate {
  credits: number | null;
  lowerBoundCredits: number;
  usd: number | null;
  coverage: RunCostEstimateCoverage;
  confidence: RunCostEstimateConfidence;
  sampleCount: number;
  truncated: boolean;
  lines: RunCostEstimateLine[];
}

export type RunCostEstimateStatus = "idle" | "loading" | "ready" | "error";

export interface RunCostEstimateState {
  status: RunCostEstimateStatus;
  estimate: RunCostEstimate | null;
  /** Set when the query rejected — the hint renders "Estimate unavailable". */
  error: string | null;
  /** Call when the tooltip opens (`true`) or closes (`false`). */
  setOpen: (open: boolean) => void;
  open: boolean;
}

/** Convex query names the estimate hooks call (string-keyed, like SWARM_QUERIES). */
export const RUN_COST_ESTIMATE_QUERIES = {
  suite: "testSuites:estimateSuiteRunCredits",
  quickCase: "testSuites:estimateQuickCaseRunCredits",
  // Single spelling for the swarm surface, shared with the rest of the Swarms
  // string-keyed query registry.
  journey: SWARM_QUERIES.estimateJourneyRunCredits,
} as const;

/**
 * One fetch-on-open state machine, shared by all three surfaces.
 *
 * `enabled` folds in the PostHog flag AND any surface-specific reason to stay
 * silent (an env suite's quick-run control, a model-free case, a missing id).
 * When it is false nothing is fetched and no Convex call is made at all.
 *
 * `argsKey` must change exactly when `args` semantically changes — it is the
 * re-fetch trigger and the memo key, so it may not be derived from an object
 * identity that churns each render.
 */
function useFetchOnOpenEstimate({
  enabled,
  queryName,
  args,
  argsKey,
}: {
  enabled: boolean;
  queryName: string;
  args: Record<string, unknown> | null;
  argsKey: string;
}): RunCostEstimateState {
  const convex = useConvex();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<RunCostEstimateStatus>("idle");
  const [estimate, setEstimate] = useState<RunCostEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request id. Only the newest in-flight request may write state, so
  // a slow earlier response cannot overwrite a newer one.
  const requestIdRef = useRef(0);

  const active = enabled && open && args !== null;

  useEffect(() => {
    if (!active) {
      // Closing (or being disabled) invalidates any in-flight request as well as
      // the painted value — reopening always re-fetches rather than flashing a
      // stale number.
      requestIdRef.current += 1;
      setStatus("idle");
      setEstimate(null);
      setError(null);
      return;
    }

    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        // `args` is closed over from the render that SCHEDULED this effect, so
        // it is always a committed value. (A ref synced during render would not
        // be: an abandoned concurrent render can advance it without committing.)
        // It is memoized on the same inputs as `argsKey`, so the args and the
        // key that triggered this fetch always agree.
        const result = (await convex.query(
          queryName as any,
          args as any,
        )) as RunCostEstimate | undefined;
        if (requestId !== requestIdRef.current) return;
        setEstimate(result ?? null);
        setStatus(result ? "ready" : "error");
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setEstimate(null);
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
    // `useConvex()` may return a new object each render; the client is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, queryName, argsKey]);

  return { status, estimate, error, open, setOpen };
}

export function useSuiteRunCostEstimate({
  enabled,
  suiteId,
  caseIds,
  iterationOverride,
  planCount,
}: {
  enabled: boolean;
  suiteId: string | null | undefined;
  caseIds?: readonly string[];
  iterationOverride?: number;
  planCount?: number;
}): RunCostEstimateState {
  // Structured for the same reason as `modelsKey` below.
  const caseIdsKey = caseIds ? JSON.stringify([...caseIds]) : "";
  const args = useMemo(
    () =>
      suiteId
        ? {
            suiteId,
            ...(caseIds && caseIds.length > 0 ? { caseIds: [...caseIds] } : {}),
            ...(iterationOverride !== undefined ? { iterationOverride } : {}),
            ...(planCount !== undefined ? { planCount } : {}),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suiteId, caseIdsKey, iterationOverride, planCount],
  );
  return useFetchOnOpenEstimate({
    enabled: enabled && Boolean(suiteId),
    queryName: RUN_COST_ESTIMATE_QUERIES.suite,
    args,
    argsKey: `${suiteId ?? ""}|${caseIdsKey}|${iterationOverride ?? ""}|${
      planCount ?? ""
    }`,
  });
}

export interface QuickCaseEstimateModel {
  model: string;
  provider: string;
}

export function useQuickCaseRunCostEstimate({
  enabled,
  suiteId,
  caseId,
  models,
  runs,
  draft,
}: {
  enabled: boolean;
  suiteId: string | null | undefined;
  caseId?: string | null;
  models: readonly QuickCaseEstimateModel[];
  runs?: number;
  draft?: { promptChars: number; stepCount: number };
}): RunCostEstimateState {
  // Structured serialization, not a delimiter join: `model` can itself contain
  // a "/" (canonical ids like `openai/gpt-5-mini` are stored there), so a
  // hand-rolled key is not injective and two different model lists could share
  // one — leaving an open tooltip showing the previous estimate.
  const modelsKey = JSON.stringify(
    models.map((entry) => [entry.provider, entry.model]),
  );
  const draftKey = draft
    ? JSON.stringify([draft.promptChars, draft.stepCount])
    : "";
  const args = useMemo(
    () =>
      suiteId
        ? {
            suiteId,
            ...(caseId ? { caseId } : {}),
            models: models.map((entry) => ({
              model: entry.model,
              provider: entry.provider,
            })),
            ...(runs !== undefined ? { runs } : {}),
            ...(draft ? { draft } : {}),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suiteId, caseId, modelsKey, runs, draftKey],
  );
  return useFetchOnOpenEstimate({
    enabled: enabled && Boolean(suiteId),
    queryName: RUN_COST_ESTIMATE_QUERIES.quickCase,
    args,
    argsKey: `${suiteId ?? ""}|${caseId ?? ""}|${modelsKey}|${
      runs ?? ""
    }|${draftKey}`,
  });
}

export function useJourneyRunCostEstimate({
  enabled,
  journeyId,
  configKey,
}: {
  enabled: boolean;
  journeyId: string | null | undefined;
  /**
   * Signature of the journey's cost-relevant config (targets, sessions, turns,
   * judge autoRun). The query itself only takes `journeyId` and resolves
   * everything else server-side, so without this the estimate would keep showing
   * a pre-edit number for as long as the tooltip stayed open. Folding the
   * signature into the request key makes a config edit re-fetch in place.
   *
   * This covers journey-level edits only. A change to a HOST's model is resolved
   * server-side and isn't visible on the journey DTO, so that still needs a
   * reopen.
   */
  configKey?: string;
}): RunCostEstimateState {
  const args = useMemo(() => (journeyId ? { journeyId } : null), [journeyId]);
  return useFetchOnOpenEstimate({
    enabled: enabled && Boolean(journeyId),
    queryName: RUN_COST_ESTIMATE_QUERIES.journey,
    args,
    argsKey: `${journeyId ?? ""}|${configKey ?? ""}`,
  });
}

/**
 * Tooltip copy, keyed on BOTH coverage and confidence.
 *
 * The two dimensions answer different questions and neither subsumes the other:
 * coverage says whether every line could be priced at all, confidence says how
 * much the priced part is grounded in this user's own history. A partial-coverage
 * estimate is always phrased as a floor ("At least"), because its total is
 * genuinely incomplete.
 */
export function formatRunCostEstimate(
  state: Pick<RunCostEstimateState, "status" | "estimate" | "error">,
): string {
  // `idle` is the frame between the tooltip opening and the fetch effect
  // committing `loading`. Falling through to "Estimate unavailable" there would
  // flash alarming copy that immediately retracts itself, so idle reads as
  // pending too.
  if (state.status === "loading" || state.status === "idle") {
    return "Estimating…";
  }
  if (state.status === "error" || !state.estimate) {
    return "Estimate unavailable";
  }
  const { coverage, confidence, credits, lowerBoundCredits } = state.estimate;
  if (coverage === "none") {
    return "Estimate unavailable for these models";
  }
  if (coverage === "partial") {
    // Phrased as a floor, and deliberately not model-specific: an unpriced line
    // can also be an un-estimated slice of the run's fan-out, not just a model
    // whose price is unknown.
    return `At least ~${formatCredits(
      lowerBoundCredits,
    )} credits — part of this run is unpriced`;
  }
  const total = formatCredits(credits ?? lowerBoundCredits);
  switch (confidence) {
    case "historical":
      return `Estimated: ~${total} credits — based on your recent runs`;
    case "partial":
      return `Estimated: ~${total} credits — partly based on recent runs`;
    default:
      return `Rough estimate: ~${total} credits — improves after first run`;
  }
}

/**
 * Locale-pinned so the separator matches the surrounding English copy — and so
 * the number doesn't change shape with the runtime locale.
 *
 * Rounds UP, not to nearest. Every `credits` value the backend emits is already
 * an integer by construction (`evalUnitCredits` is a max of integers, swarm
 * components sum `calculateCreditCost`, judge and computer lines are `ceil`,
 * each times an integer unit count), so this is identity today. It rounds up
 * anyway because the one direction this display must never fail in is low: were
 * a fractional credit ever to reach here, `Math.round` would render a real
 * 0.4-credit cost as "~0 credits".
 */
export function formatCredits(credits: number): string {
  return Math.max(0, Math.ceil(credits)).toLocaleString("en-US");
}
