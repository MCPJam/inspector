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
   * The authored case's stage-applicability inputs. NOT persisted on the
   * iteration, so the read surface resolves it from the suite the same way the
   * runner did — absent ⇒ this iteration gets no chain, exactly as in the
   * first pass, rather than a guessed one.
   */
  stageCase?: StageAuthoredCase;
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
};

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
  return await postJson<JudgeSecondPassRunRow>("/runs/judge-derivation-input", {
    runId,
  });
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
