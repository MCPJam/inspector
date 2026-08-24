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
 * ONE SURFACE IS NOT DEPLOYED YET. `internalApplyJudgeStageDerivation` has its
 * HTTP route (W1) and is called for real below. The other two facts this pass
 * needs — reading a run's iterations without a user bearer, and reporting
 * outcomes to `judgeStageFanoutMutations.markFanout` — exist in the backend
 * only as internal Convex functions with NO service-token HTTP route, so they
 * are unreachable from here. Their clients are written to the expected paths
 * and shapes and will start working the moment the routes land; until then a
 * call returns `routeMissing`, which is why `dual_write` cannot be promoted on
 * this wave. Nothing at `off` or `shadow` reaches any of them.
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
  gradingEngine?: { mode?: unknown };
  configSnapshot?: { gradingEngine?: { mode?: unknown } };
  iterations: JudgeSecondPassIterationRow[];
};

/**
 * Read the run and its iterations WITHOUT a user bearer.
 *
 * NOT DEPLOYED YET — see the module docblock. The doorbell carries a run id and
 * nothing else, so the pass has to reread every fact it grades on; that read
 * needs a service-token route because the worker has no user identity to use.
 */
export async function fetchRunForJudgeSecondPass(
  runId: string
): Promise<JudgeSecondPassRunRow> {
  return await postJson<JudgeSecondPassRunRow>("/runs/judge-derivation-input", {
    runId,
  });
}

/**
 * Report the graded set to `judgeStageFanoutMutations.markFanout`.
 *
 * Only iterations this pass ACTUALLY graded are reported: the backend decides
 * completeness from the reported set, so padding it with ungraded rows would
 * mark a fanout complete that never ran.
 *
 * NOT DEPLOYED YET — see the module docblock.
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
