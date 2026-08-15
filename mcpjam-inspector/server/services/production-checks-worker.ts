/**
 * production-checks-worker.ts — polling grader for production scoring.
 *
 * Grades REAL User Testing sessions against their chatbox's rubric of
 * deterministic checks. Same pull/claim architecture as
 * `scheduled-evals-worker.ts` — the backend's idle detector enqueues
 * `productionCheckTriggers` rows, this loop claims one at a time over the
 * service-token-gated `/internal/v1/production-checks/*` routes, and the
 * backend never calls the Inspector.
 *
 * Two deliberate simplifications versus the scheduled-evals worker:
 *   - NO delegated user token. The claim response carries everything the
 *     grade needs (rubric, transcript envelope, token totals), the routes are
 *     service-token-gated, and the rubric comes from the chatbox config read
 *     inside the claim transaction — a worker cannot choose what it grades
 *     against, so there is no user authority to borrow.
 *   - NO external pipeline. Grading is a pure `evaluatePredicates` call over
 *     the claimed envelope — the same evaluator, transcript builder, and
 *     tool-call walker the swarm checks runner uses, so a verdict cannot
 *     depend on which grader asked.
 *
 * ONE switch, and it is the backend's `PRODUCTION_CHECKS_ENABLED`. This worker
 * has deliberately no flag of its own, unlike its scheduled-evals and
 * github-checks siblings — a second gate here bought nothing the two existing
 * ones don't already provide, and cost the failure mode where the feature
 * reads as ON while silently doing nothing:
 *
 *   - being a worker at all requires `CONVEX_HTTP_URL` +
 *     `INSPECTOR_SERVICE_TOKEN`; a deployment without them is not an
 *     infrastructure peer and never starts the loop;
 *   - the feature being off means the claim route 404s, which this loop reads
 *     as "disabled" and backs off to one poll a minute until it flips.
 */

import { logger } from "../utils/logger";
import {
  buildIterationTranscript,
  evaluatePredicates,
  summarizeRenderObservations,
} from "@/shared/eval-matching";
import type { Predicate } from "@/shared/eval-matching";
import type { RunnerWidgetRenderObservation } from "@/shared/eval-trace";
import { extractToolCallsFromEnvelopeMessages } from "./checks/run-predicates-on-chat-session.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_JITTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/** Per-request cap so a stalled Convex can't wedge the loop. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;

export type ClaimedProductionCheck = {
  triggerId: string;
  sessionDocId: string;
  checkDocId: string;
  generation: number;
  criteria: Array<{ id: string; label?: string; predicate: Predicate }>;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  envelope: {
    messages?: unknown[];
    spans?: unknown[];
    widgetRenderObservations?: unknown[];
  } | null;
};

type ClaimOutcome =
  | { kind: "claimed"; claim: ClaimedProductionCheck }
  | { kind: "empty" }
  /** A trigger was consumed without producing work — poll again immediately. */
  | { kind: "drained" }
  | { kind: "disabled" };

function requiredEnv(): { convexUrl: string; serviceToken: string } | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) return null;
  return { convexUrl, serviceToken };
}

async function postServiceRoute(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const env = requiredEnv();
  if (!env) {
    throw new Error(
      "Production checks worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SERVICE_ROUTE_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(`${env.convexUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-inspector-service-token": env.serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    // tolerated; status carries the signal
  }
  return { status: response.status, body: parsed };
}

async function claimNext(claimedBy: string): Promise<ClaimOutcome> {
  const { status, body } = await postServiceRoute(
    "/internal/v1/production-checks/claim",
    { claimedBy },
  );
  // 404 = PRODUCTION_CHECKS_ENABLED is off backend-side; nothing to do,
  // long backoff so flipping the flag doesn't need an Inspector restart.
  if (status === 404) return { kind: "disabled" };
  if (status !== 200 || !body?.ok) {
    throw new Error(`claim failed (${status}): ${JSON.stringify(body)}`);
  }
  if (body.claimed !== true) {
    // `retry` means the mutation consumed a stale trigger (chatbox disabled,
    // session gone) — the queue behind it may still hold live work.
    return body.retry === true ? { kind: "drained" } : { kind: "empty" };
  }
  if (
    typeof body.triggerId !== "string" ||
    typeof body.sessionDocId !== "string" ||
    typeof body.checkDocId !== "string" ||
    typeof body.generation !== "number" ||
    !Array.isArray(body.criteria)
  ) {
    throw new Error("claim returned a malformed payload");
  }
  return {
    kind: "claimed",
    claim: {
      triggerId: body.triggerId,
      sessionDocId: body.sessionDocId,
      checkDocId: body.checkDocId,
      generation: body.generation,
      criteria: body.criteria,
      usage: body.usage ?? null,
      envelope: body.envelope ?? null,
    },
  };
}

/**
 * Validated token totals for the SDK evaluator. Wire data: a malformed field
 * degrades to "unmeasured" (undefined), never to a number that could pass a
 * budget. Mirrors the swarm checks runner's rule.
 */
function claimUsage(
  usage: ClaimedProductionCheck["usage"],
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!usage) return undefined;
  const inputTokens =
    typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens)
      ? usage.inputTokens
      : undefined;
  const outputTokens =
    typeof usage.outputTokens === "number" &&
    Number.isFinite(usage.outputTokens)
      ? usage.outputTokens
      : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/** Execute one claimed grade end-to-end. Never throws. */
export async function executeClaimedCheck(
  claim: ClaimedProductionCheck,
): Promise<void> {
  const reportFail = async (error: string) => {
    try {
      await postServiceRoute("/internal/v1/production-checks/fail", {
        triggerId: claim.triggerId,
        sessionDocId: claim.sessionDocId,
        checkDocId: claim.checkDocId,
        generation: claim.generation,
        error,
      });
    } catch (reportError) {
      // Best-effort: the claim's durable `pending` stands, and the backend's
      // stale-lease sweep recovers the trigger.
      logger.warn("[production-checks] failed to report grading failure", {
        triggerId: claim.triggerId,
        error:
          reportError instanceof Error
            ? reportError.message
            : String(reportError),
      });
    }
  };

  const messages = Array.isArray(claim.envelope?.messages)
    ? (claim.envelope.messages as Array<{ role: string; content: unknown }>)
    : null;
  if (messages === null) {
    await reportFail("transcript envelope unreadable");
    return;
  }

  let criterionResults: Array<{
    criterionId: string;
    passed: boolean;
    reason: string;
  }>;
  try {
    const observations = claim.envelope?.widgetRenderObservations;
    const transcript = buildIterationTranscript({
      trace: {
        messages,
        ...(claim.envelope?.spans
          ? { spans: claim.envelope.spans as never[] }
          : {}),
      },
      // The SHARED walker — same one the swarm and on-demand graders use, so
      // the same session grades identically whichever grader asks.
      toolCalls: extractToolCallsFromEnvelopeMessages(messages),
      usage: claimUsage(claim.usage),
      // Real chatbox sessions rarely carry render observations (no browser
      // harness on that surface); absent stays absent so `widget*` checks
      // fail closed rather than passing on no signal.
      ...(Array.isArray(observations) && observations.length > 0
        ? {
            renderObservations: summarizeRenderObservations(
              observations as RunnerWidgetRenderObservation[],
            ),
          }
        : {}),
      turnCount: messages.filter((msg) => msg?.role === "user").length,
    });
    const results = evaluatePredicates(
      transcript,
      claim.criteria.map((entry) => entry.predicate),
    );
    // Positional correlation — both arrays derive from the same
    // `claim.criteria` and `evaluatePredicates` preserves order by contract.
    criterionResults = claim.criteria.map((entry, index) => ({
      criterionId: entry.id,
      passed: results[index]?.passed ?? false,
      reason: results[index]?.reason ?? "evaluator returned no verdict",
    }));
  } catch (error) {
    await reportFail(error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    const { status, body } = await postServiceRoute(
      "/internal/v1/production-checks/complete",
      {
        triggerId: claim.triggerId,
        sessionDocId: claim.sessionDocId,
        checkDocId: claim.checkDocId,
        generation: claim.generation,
        criterionResults,
      },
    );
    if (status !== 200 || !body?.ok) {
      logger.warn("[production-checks] complete rejected", {
        triggerId: claim.triggerId,
        status,
      });
    }
  } catch (error) {
    // The durable `pending` + lease recovery make this safe to drop.
    logger.warn("[production-checks] failed to report completion", {
      triggerId: claim.triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export interface ProductionChecksWorkerHandle {
  /** Aborts polling and resolves once the loop (incl. an in-flight grade) settles. */
  stop: () => Promise<void>;
}

/**
 * Start the polling loop. Called unconditionally from server bootstrap — it
 * self-gates on the service-token env below, so a deployment that is not an
 * infrastructure peer gets an inert handle. One grade in flight per instance;
 * multiple instances race safely (the claim is an atomic Convex mutation).
 */
export function startProductionChecksWorker(options?: {
  claimedBy?: string;
  /** Test seam: overrides the claim/execute pair. */
  claim?: typeof claimNext;
  execute?: typeof executeClaimedCheck;
}): ProductionChecksWorkerHandle {
  const abort = new AbortController();
  const claimedBy =
    options?.claimedBy ??
    `inspector-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
  const claim = options?.claim ?? claimNext;
  const execute = options?.execute ?? executeClaimedCheck;

  // Not a worker peer — every local dev and self-hosted inspector lands here.
  // Silent on purpose: with no flag to contradict, absent credentials are the
  // normal case rather than a misconfiguration worth warning about.
  if (!requiredEnv()) {
    return { stop: async () => {} };
  }

  logger.info("[production-checks] worker started", { claimedBy });

  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs =
        POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
      try {
        const outcome = await claim(claimedBy);
        if (outcome.kind === "disabled") {
          waitMs = ERROR_BACKOFF_MS;
        } else if (outcome.kind === "drained") {
          // A stale trigger was consumed; live work may be queued behind it.
          waitMs = 250;
        } else if (outcome.kind === "claimed") {
          await execute(outcome.claim);
          // Drain mode: an idle chatbox enqueues sessions in a burst.
          waitMs = 1_000;
        }
      } catch (error) {
        logger.warn("[production-checks] poll failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs, abort.signal);
    }
    logger.info("[production-checks] worker stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      // Bounded by the caller's shutdown force-exit timer; grades that
      // outlast it are recovered by the backend's stale-lease sweep.
      await loop;
    },
  };
}
