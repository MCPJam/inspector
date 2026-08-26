/**
 * The chat-session derivation pass.
 *
 * Structurally the same shape as `evals/judge-second-pass.ts`, and for the
 * same reasons: the caller is a doorbell that answers before the work
 * finishes, the pass rereads current state rather than trusting anything the
 * doorbell carried, it derives ONCE through the shared SDK analyzer, and it
 * writes under a compare-and-set that makes a duplicate ring produce the same
 * rows rather than a race.
 *
 * WHAT IT NEVER DOES:
 *
 *   - Spend. There is no model call anywhere in this file. The pass consumes
 *     deterministic criteria and whatever judge verdict already exists; it
 *     never asks for one. A derivation pass that could trigger a judge would
 *     turn every re-mark into a bill.
 *   - Derive twice. `buildChatSessionStageInput` + `deriveStageResults` is the
 *     one path, the same one every eval iteration goes through.
 *   - Move a verdict. Nothing here touches readiness, criteria, a goal score,
 *     an attempt status or a run summary.
 *   - Store free text. Failures are reported as one of the backend's CLOSED
 *     error codes. An exception message from a transcript walker is customer
 *     evidence, and the session row is read by every list payload.
 *
 * SUPERSEDED IS SUCCESS. A no-op apply means someone asked for better work
 * while this was in flight. Retrying would lose the same race again; the newer
 * generation is already pending and will be claimed on its own.
 */

import {
  buildChatSessionStageInput,
  deriveStageResults,
} from "@mcpjam/sdk/contract";
import { logger } from "../../utils/logger.js";
import {
  applyStageDerivation,
  claimNextStageDerivation,
  failStageDerivation,
  chatStageWorkerConfigured,
  type ClaimedStageDerivation,
} from "./chat-session-stage-backend.js";
import { normalizeClaimedEvidence } from "./normalize-claimed-evidence.js";

/**
 * How many claims one ring drains.
 *
 * A producer marks per session and a swarm run finishing marks a burst of
 * them, so answering one ring with one derivation would leave the rest waiting
 * on the backend's recovery interval. Bounded so a large backlog cannot hold
 * the pass open indefinitely — the sweep is the delivery guarantee, not this
 * number.
 */
const MAX_CLAIMS_PER_PASS = 25;

export type StageDerivationOutcome =
  | "applied"
  | "superseded"
  | "invalid"
  | "evidence_unavailable"
  | "worker_error";

export type ChatSessionStagePassResult = {
  /** True when the pass decided to do nothing (unconfigured, feature off). */
  noop: boolean;
  claimed: number;
  outcomes: Array<{ sessionDocId: string; outcome: StageDerivationOutcome }>;
  reason?: "not_configured" | "disabled" | "empty" | "backend_unavailable";
};

/** The three backend calls, injectable for tests. */
export type ChatSessionStagePassPorts = {
  claim: typeof claimNextStageDerivation;
  apply: typeof applyStageDerivation;
  reportFailure: typeof failStageDerivation;
};

const defaultPorts: ChatSessionStagePassPorts = {
  claim: claimNextStageDerivation,
  apply: applyStageDerivation,
  reportFailure: failStageDerivation,
};

/**
 * Derive and apply ONE claimed session.
 *
 * Exported so a test can hold a single claim against it without a loop, and so
 * the failure paths are legible in isolation.
 */
export async function deriveClaimedSession(
  claim: ClaimedStageDerivation,
  ports: ChatSessionStagePassPorts = defaultPorts
): Promise<StageDerivationOutcome> {
  const normalized = normalizeClaimedEvidence(claim);
  if (!normalized.ok) {
    await ports.reportFailure({
      sessionDocId: claim.sessionDocId,
      generation: claim.generation,
      errorCode: normalized.errorCode,
      // Retryable: an envelope can become readable once ingest settles, and a
      // permanently broken one exhausts the attempt budget and parks visibly.
      retryable: true,
    });
    return normalized.errorCode;
  }

  let derivation: ReturnType<typeof deriveStageResults>;
  try {
    derivation = deriveStageResults(
      buildChatSessionStageInput(normalized.input)
    );
  } catch (error) {
    // The analyzer is pure and total, so this is a bug rather than a data
    // condition — which is exactly why it is reported as `worker_error` and
    // never as a chain. Only the session id is safe to log.
    logger.warn("[chat-stage] derivation threw", {
      sessionDocId: claim.sessionDocId,
      error: error instanceof Error ? error.name : "unknown",
    });
    await ports.reportFailure({
      sessionDocId: claim.sessionDocId,
      generation: claim.generation,
      errorCode: "worker_error",
      retryable: true,
    });
    return "worker_error";
  }

  let applied: Awaited<ReturnType<typeof applyStageDerivation>>;
  try {
    applied = await ports.apply({
      sessionDocId: claim.sessionDocId,
      generation: claim.generation,
      // Handed back VERBATIM. The pass never rebuilds the stamp: a worker able
      // to choose it could declare its own stale work fresh.
      sourceStamp: claim.sourceStamp,
      stageResults: derivation.stageResults,
      ...(derivation.firstFailedStage
        ? { firstFailedStage: derivation.firstFailedStage }
        : {}),
      ...(derivation.failureCategory
        ? { failureCategory: derivation.failureCategory }
        : {}),
      stageAnalyzerVersion: derivation.stageAnalyzerVersion,
    });
  } catch (error) {
    // The apply is the one backend call that used to run unguarded, and it
    // throws on any non-200 and rejects on a transport abort. That rejection
    // escaped `deriveClaimedSession`, escaped `runChatSessionStagePass` —
    // which this module's docstring promises never happens — and cost the
    // whole drain: every claim still queued behind this one was abandoned to
    // the backend's recovery interval, and the outcomes already collected
    // were thrown away with it. One row's transport failure now costs one row.
    //
    // No failure is REPORTED to the backend: the transport is what broke, not
    // the derivation, and the row's own lease is what re-offers it.
    logger.warn("[chat-stage] apply failed", {
      sessionDocId: claim.sessionDocId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "worker_error";
  }

  if (applied.kind === "applied") return "applied";
  if (applied.kind === "superseded") {
    // Not reported as a failure and not retried: the backend already holds a
    // newer pending generation, and re-claiming would just lose again.
    return "superseded";
  }
  // `invalid` means the rows failed the backend's own invariants. The apply
  // mutation has already parked the row; reporting a failure on top would
  // overwrite a more specific error code with a vaguer one.
  logger.warn("[chat-stage] backend rejected a derivation", {
    sessionDocId: claim.sessionDocId,
    reason: applied.reason,
  });
  return "invalid";
}

/**
 * Drain the queue.
 *
 * Idempotent and safe to re-run: every claim is an atomic backend mutation, a
 * duplicate ring finds an empty queue, and two instances racing each claim
 * different rows. Never throws — the caller is a doorbell that has already
 * answered.
 */
export async function runChatSessionStagePass(options?: {
  claimedBy?: string;
  ports?: Partial<ChatSessionStagePassPorts>;
  maxClaims?: number;
}): Promise<ChatSessionStagePassResult> {
  const ports: ChatSessionStagePassPorts = {
    ...defaultPorts,
    ...(options?.ports ?? {}),
  };
  const outcomes: ChatSessionStagePassResult["outcomes"] = [];

  if (!options?.ports && !chatStageWorkerConfigured()) {
    // Not an infrastructure peer. Every local dev and self-hosted inspector
    // lands here, and it is the normal case rather than a misconfiguration.
    return { noop: true, claimed: 0, outcomes, reason: "not_configured" };
  }

  const claimedBy =
    options?.claimedBy ??
    `inspector-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
  const maxClaims = options?.maxClaims ?? MAX_CLAIMS_PER_PASS;

  for (let drained = 0; drained < maxClaims; drained += 1) {
    let outcome: Awaited<ReturnType<typeof claimNextStageDerivation>>;
    try {
      outcome = await ports.claim(claimedBy);
    } catch (error) {
      logger.warn("[chat-stage] claim failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        noop: outcomes.length === 0,
        claimed: outcomes.length,
        outcomes,
        reason: "backend_unavailable",
      };
    }

    if (outcome.kind === "disabled") {
      return {
        noop: outcomes.length === 0,
        claimed: outcomes.length,
        outcomes,
        reason: "disabled",
      };
    }
    if (outcome.kind === "empty") {
      return {
        noop: outcomes.length === 0,
        claimed: outcomes.length,
        outcomes,
        ...(outcomes.length === 0 ? { reason: "empty" as const } : {}),
      };
    }
    // `drained` — a row was consumed without producing work (a parked poison
    // session). Live work may still be queued behind it, so keep going.
    if (outcome.kind === "drained") continue;

    outcomes.push({
      sessionDocId: outcome.claim.sessionDocId,
      outcome: await deriveClaimedSession(outcome.claim, ports),
    });
  }

  return { noop: false, claimed: outcomes.length, outcomes };
}
