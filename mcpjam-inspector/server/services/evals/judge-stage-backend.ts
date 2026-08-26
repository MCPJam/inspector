/**
 * The inspector's client for the backend's judge-stage-derivation surfaces.
 *
 * Same channel as `server-connections-backend.ts`: service token in
 * `x-inspector-service-token`, one bounded `fetch`, no user bearer. The pass
 * that calls this is a durable worker triggered by a doorbell, so it has NO
 * user identity — forwarding the run creator's bearer would be impersonation,
 * which is why the write target is an internal mutation behind a service-token
 * route rather than `testSuites:updateTestIteration`.
 *
 * THE MERGE IS THE BACKEND'S. Only derivation-owned keys are posted; the
 * backend merges them into `metadata` inside its own transaction, replaces
 * score rows by `scorerId`, and re-attaches the server-written judge keys.
 * Posting a whole metadata blob would reintroduce the lost-update this design
 * exists to remove, and `status` / `result` are rejected outright
 * (`JUDGE_DERIVATION_LIFECYCLE_FORBIDDEN`) — the second pass never touches an
 * iteration's lifecycle.
 *
 * ALL THREE SURFACES ARE NOW DEPLOYED (PR 0 of the D7 plan closed the gap this
 * docblock used to describe): `internalApplyJudgeStageDerivation`'s route
 * shipped in Wave 1; the read (`/runs/judge-derivation-input`) and the
 * goal-completion fanout report (`/runs/judge-stage-fanout`) shipped
 * alongside D7. `isRouteMissing` / `ROUTE_NOT_DEPLOYED` handling is kept as a
 * deploy-order safety net (an inspector build that runs ahead of its backend
 * deploy), not because a gap is expected in steady state.
 *
 * D7 (metadata-attribution) rides the SAME read (`fetchRunForJudgeSecondPass`
 * already returns `metadataAttributionJobId` alongside `goalCompletionJobId`)
 * but writes and reports through its OWN pair of functions below
 * (`applyMetadataAttributionStageDerivation` /
 * `markMetadataAttributionStageFanout`) — its own job id, its own staleness
 * check, its own fanout state on the run row. See the D7 plan §2/§3 for why
 * it is a sibling judge rather than a rider on goal-completion's job id.
 */

import type { ModelMessage } from "ai";
import type { EvalTraceSpan, PromptTraceSummary } from "@/shared/eval-trace";
import type {
  StageAuthoredCase,
  StageSetupSignals,
  TestStep,
} from "@mcpjam/sdk/contract";
import type { ToolExposureSignals } from "@mcpjam/sdk/host-config/internal";
import { isAbortError } from "@/shared/abort-errors";
import { getInternalBackendConfig } from "../internal-backend.js";

const EVALS_BASE_PATH = "/internal/v1/evals";
const REQUEST_TIMEOUT_MS = 15_000;

/** Outcome vocabulary shared by the write route and the fanout report. */
export type JudgeDerivationOutcome =
  | "applied"
  | "skipped_terminal"
  | "deferred"
  | "stale";

export class JudgeStageBackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "JudgeStageBackendError";
  }

  /** The iteration is gone. Report nothing for it and do not retry. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * The run's config moved under us (`EVAL_RUN_CONFIG_CONFLICT`). A retry
   * races the same way, so the pass stops rather than looping.
   */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** The route is not deployed on this backend. See the module docblock. */
  get isRouteMissing(): boolean {
    return this.code === "ROUTE_NOT_DEPLOYED";
  }
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${convexUrl}${EVALS_BASE_PATH}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inspector-service-token": serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = (await response.json().catch((error: unknown) => {
      if (isAbortError(error)) throw error;
      return null;
    })) as ({ ok?: boolean; error?: string; code?: string } & T) | null;

    if (!response.ok || payload?.ok !== true) {
      // A 404 whose body is not our envelope is an undeployed route, not a
      // missing row — collapsing the two sends someone hunting a document
      // when the answer is a stale backend or a wrong CONVEX_HTTP_URL.
      const undeployed = response.status === 404 && payload?.ok === undefined;
      throw new JudgeStageBackendError(
        payload?.error ?? `Judge-stage call failed (${response.status})`,
        response.status,
        undeployed ? "ROUTE_NOT_DEPLOYED" : payload?.code
      );
    }
    return payload as T;
  } catch (error) {
    if (isAbortError(error)) {
      throw new JudgeStageBackendError(
        `Judge-stage call timed out after ${REQUEST_TIMEOUT_MS}ms`,
        504
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The allowlisted derivation body. Every key here is derivation-owned; an
 * unknown key is a 400 server-side, and `status` / `result` are not
 * representable in this type ON PURPOSE.
 */
export type JudgeStageDerivationBody = {
  goalCompletionJobId: string | number;
  judgeStageDerivedAt: number;
  stageResults?: unknown[];
  firstFailedStage?: string;
  failureCategory?: string;
  stageAnalyzerVersion?: number;
  setupSignals?: unknown;
  toolSignals?: unknown;
  scores?: unknown[];
  evaluationConfig?: unknown;
};

/** `POST /internal/v1/evals/iterations/:iterationId/stage-derivation` (W1). */
export async function applyJudgeStageDerivation(
  iterationId: string,
  body: JudgeStageDerivationBody
): Promise<{ outcome: JudgeDerivationOutcome; reason?: string }> {
  return await postJson<{ outcome: JudgeDerivationOutcome; reason?: string }>(
    `/iterations/${encodeURIComponent(iterationId)}/stage-derivation`,
    { ...body }
  );
}

/**
 * One iteration of a run, as the second pass needs to see it: the same
 * evidence the first pass derived from, plus the server-written
 * `metadata.judgeVerdict` that is the only new fact.
 */
export type JudgeSecondPassIterationRow = {
  iterationId: string;
  status?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  spans?: EvalTraceSpan[];
  prompts?: PromptTraceSummary[];
  messages?: ModelMessage[];
  /**
   * The RUN'S OWN frozen snapshot of the authored case, not a derived
   * `StageAuthoredCase`.
   *
   * Stage applicability is inferred by the SDK's `buildStageAuthoredCase` — the
   * same function the runner used on the first pass — so the backend hands back
   * the raw case and this side derives. Mirroring that inference in Convex
   * would put a second implementation of "what does this case assert" in the
   * repository least able to test it against the analyzer. Absent ⇒ this
   * iteration gets no chain, exactly as in the first pass, rather than a
   * guessed one.
   */
  authoredCase?: {
    isNegativeTest?: boolean;
    expectedOutput?: string;
    expectedToolCalls?: readonly unknown[];
    successPredicates?: readonly unknown[];
    caseType?: string;
    steps?: readonly TestStep[];
    promptTurns?: ReadonlyArray<{ expectedToolCalls?: readonly unknown[] }>;
  };
  /**
   * The backend's OWN derived shape, still served beside the raw case for D7's
   * consumer. Read only as a fallback when `authoredCase` is absent — a row
   * that carries just this must still derive a chain, so the field has to stay
   * on the contract as well as in the code that reads it.
   */
  stageCase?: StageAuthoredCase;
  /** Snapshotted per-case options, for the `toolCalls:match` definition hash. */
  matchOptions?: Record<string, unknown>;
  isNegativeTest?: boolean;
  /**
   * Whether the persisted TRACE came back in full.
   *
   * `false` ⇒ the backend could not serve this iteration's spans within its
   * byte budget. The analyzer reports `traceAbsent` when handed no spans, so
   * re-deriving here would replace a correct user-value chain with one saying
   * nothing happened — this pass therefore posts NO stage keys for such a row.
   * A partial chain is worse than none: none leaves the first pass's standing.
   */
  traceComplete?: boolean;
  toolSignals?: ToolExposureSignals;
  setupSignals?: StageSetupSignals;
};

export type JudgeSecondPassRunRow = {
  runId: string;
  goalCompletionJobId?: string | number;
  /** D7's own job id — set only when its own auto-trigger fired for this run. */
  metadataAttributionJobId?: string | number;
  gradingEngine?: { mode?: unknown };
  configSnapshot?: { gradingEngine?: { mode?: unknown } };
  iterations: JudgeSecondPassIterationRow[];
  /**
   * True when the run has MORE iterations than this fetch retrieved.
   *
   * The pass reports the set it graded, and the backend marks a fanout
   * complete when every reported outcome succeeded — it cannot tell a fully
   * graded run from one whose tail was never fetched. So a partial fetch must
   * never be allowed to complete a fanout; the pass reports `failed` instead
   * and lets the sweep re-drive it.
   */
  incomplete?: boolean;
};

/** Pages one fetch will follow before giving up. 200 iterations per page. */
const MAX_DERIVATION_INPUT_PAGES = 25;

/**
 * Read the run and its iterations WITHOUT a user bearer.
 *
 * The doorbell carries a run id and nothing else, so the pass has to reread
 * every fact it grades on; that read needs a service-token route because the
 * worker has no user identity to use. GENERIC across judges: the same call
 * returns both `goalCompletionJobId` and `metadataAttributionJobId`, so a
 * second pass rereads once regardless of which judge(s) fired for this run.
 */
export async function fetchRunForJudgeSecondPass(
  runId: string
): Promise<JudgeSecondPassRunRow> {
  // FOLLOWS THE CURSOR. The route pages at 200 iterations, and a consumer that
  // took only the first page would grade the head of a long run, report every
  // outcome as applied, and let the backend mark the fanout complete — leaving
  // the tail permanently ungraded with nothing to re-drive it. A run of 25
  // cases at 10 repetitions already exceeds one page.
  //
  // Paging is an implementation detail of this port: `runJudgeSecondPass` sees
  // one run row either way.
  let cursor: string | undefined;
  let head: JudgeSecondPassRunRow | undefined;
  const iterations: JudgeSecondPassIterationRow[] = [];

  for (let page = 0; page < MAX_DERIVATION_INPUT_PAGES; page += 1) {
    const body: Record<string, unknown> = { runId };
    if (cursor !== undefined) body.cursor = cursor;
    const response = await postJson<
      JudgeSecondPassRunRow & { nextCursor?: string }
    >("/runs/judge-derivation-input", body);

    head ??= response;
    iterations.push(...(response.iterations ?? []));
    if (response.nextCursor === undefined) {
      return { ...head, iterations };
    }
    cursor = response.nextCursor;
  }

  // A run longer than the page budget. Reported rather than silently truncated
  // — see `incomplete`.
  return { ...(head as JudgeSecondPassRunRow), iterations, incomplete: true };
}

/**
 * Report the graded set to `judgeStageFanoutMutations.markFanout`
 * (goal-completion's fanout state).
 *
 * Only iterations this pass ACTUALLY graded are reported: the backend decides
 * completeness from the reported set, so padding it with ungraded rows would
 * mark a fanout complete that never ran.
 */
export async function markJudgeStageFanout(report: {
  runId: string;
  goalCompletionJobId: string | number;
  outcomes: Array<{ iterationId: string; outcome: JudgeDerivationOutcome }>;
  failed?: boolean;
}): Promise<{ outcome: string }> {
  return await postJson<{ outcome: string }>("/runs/judge-stage-fanout", {
    ...report,
  });
}

/**
 * D7's allowlisted derivation body. Strictly smaller than
 * {@link JudgeStageDerivationBody}: no `scores` / `evaluationConfig` — D7
 * never produces a `ScoreResult` row, it only recolors an already-`failed`
 * stage's category.
 */
export type MetadataAttributionStageDerivationBody = {
  metadataAttributionJobId: string | number;
  judgeStageDerivedAt: number;
  stageResults?: unknown[];
  firstFailedStage?: string;
  failureCategory?: string;
  stageAnalyzerVersion?: number;
};

/**
 * `POST /internal/v1/evals/iterations/:iterationId/metadata-attribution-derivation`.
 *
 * Sibling of {@link applyJudgeStageDerivation}, same shared HTTP handler
 * (one registration, two suffixes — see `convex/http.ts`), own mutation and
 * own staleness key on the backend (`metadataAttributionJobId`, not
 * `goalCompletionJobId`).
 */
export async function applyMetadataAttributionStageDerivation(
  iterationId: string,
  body: MetadataAttributionStageDerivationBody
): Promise<{ outcome: JudgeDerivationOutcome; reason?: string }> {
  return await postJson<{ outcome: JudgeDerivationOutcome; reason?: string }>(
    `/iterations/${encodeURIComponent(iterationId)}/metadata-attribution-derivation`,
    { ...body }
  );
}

/**
 * Report D7's graded set to `metadataAttributionStageFanoutMutations.markFanout`.
 *
 * Same "only what was actually graded" contract as
 * {@link markJudgeStageFanout}, reported against D7's own fanout state
 * (`metadataAttributionStageFanout` on the run row) so goal-completion's
 * fanout is never touched by a run that only D7 graded, and vice versa.
 */
export async function markMetadataAttributionStageFanout(report: {
  runId: string;
  metadataAttributionJobId: string | number;
  outcomes: Array<{ iterationId: string; outcome: JudgeDerivationOutcome }>;
  failed?: boolean;
}): Promise<{ outcome: string }> {
  return await postJson<{ outcome: string }>(
    "/runs/metadata-attribution-stage-fanout",
    { ...report }
  );
}
