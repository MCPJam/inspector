/**
 * Shadow-mode disagreement telemetry.
 *
 * The success signal is SILENCE: agreement emits nothing at all, which is what
 * the parity harnesses assert (`toHaveBeenCalledTimes(0)`). A payload only ever
 * exists because the score engine and the legacy verdict disagreed.
 *
 * Every field here is a key, a hash, a boolean or a closed-vocabulary label.
 * NEVER included: `caseKey` (titles are user prose — the hash goes instead),
 * transcripts, prompts, tool arguments or results, rationales, `evidence[]`,
 * rubric text, `expectedOutput`, server URLs. A mismatch report has to be safe
 * to read in an operator dashboard without being a data-export path.
 *
 * No sampling — a mismatch is rare by construction and dropping some would make
 * "how many disagreed?" unanswerable. Bounded instead: deduped by
 * `(runId, iterationId, mismatchKind)` and capped at 50 per run, after which one
 * `grading_shadow_mismatch_truncated` row is emitted and the rest are dropped.
 */

import { logger } from "../../utils/logger.js";
import { sha256Hex } from "@mcpjam/sdk/contract";
import type { FailureCategory, StageResultRow } from "@mcpjam/sdk/contract";
import { HOSTED_MODE } from "../../config.js";
import { resolveAppVersion } from "../../utils/log-events.js";
import type { GradingEngineMode } from "./grading-mode.js";

/** Max mismatch payloads emitted per run before truncation. */
export const MAX_SHADOW_MISMATCHES_PER_RUN = 50;

/** What kind of disagreement this is. Closed vocabulary — aggregatable. */
export type ShadowMismatchKind =
  /** The legacy verdict passed and the shadow rows failed. */
  | "legacyPassedShadowFailed"
  /** The legacy verdict failed and the shadow rows passed. */
  | "legacyFailedShadowPassed"
  /** Verdicts agree, but the derived userValue row moved. */
  | "userValueRowChanged";

/** The legacy side: today's authoritative verdict plus its derived rows. */
export type ShadowMismatchLegacySide = {
  runId: string;
  iterationId: string;
  /** Hashed here — never carried in the payload. */
  caseKey?: string;
  passed: boolean;
  userValue?: Pick<StageResultRow, "state" | "reason">;
  failureCategory?: FailureCategory;
  stageAnalyzerVersion?: number;
};

/** The shadow side: what the score engine would have said. */
export type ShadowMismatchShadowSide = {
  passed: boolean;
  userValue?: Pick<StageResultRow, "state" | "reason">;
  failureCategory?: FailureCategory;
  stageAnalyzerVersion?: number;
  /** Ids ONLY. Never rationales, never evidence. */
  disagreeingScorerIds?: readonly string[];
  definitionHash?: string;
  evaluationConfigHash?: string;
  judgeTemplateVersion?: number;
  judgeTemplateHash?: string;
  mode: GradingEngineMode;
};

/** The content-free payload emitted on disagreement. */
export type ShadowMismatch = {
  runId: string;
  iterationId: string;
  caseKeyHash?: string;
  legacyPassed: boolean;
  shadowPassed: boolean;
  legacyUserValueState?: string;
  legacyUserValueReason?: string;
  shadowUserValueState?: string;
  shadowUserValueReason?: string;
  legacyFailureCategory?: FailureCategory;
  shadowFailureCategory?: FailureCategory;
  mismatchKind: ShadowMismatchKind;
  disagreeingScorerIds?: string[];
  definitionHash?: string;
  evaluationConfigHash?: string;
  judgeTemplateVersion?: number;
  judgeTemplateHash?: string;
  stageAnalyzerVersion?: number;
  mode: GradingEngineMode;
  inspectorVersion?: string;
  deployment: "hosted" | "self_hosted";
};

function sameRow(
  a: Pick<StageResultRow, "state" | "reason"> | undefined,
  b: Pick<StageResultRow, "state" | "reason"> | undefined
): boolean {
  return a?.state === b?.state && a?.reason === b?.reason;
}

function classify(
  legacy: ShadowMismatchLegacySide,
  shadow: ShadowMismatchShadowSide
): ShadowMismatchKind | undefined {
  if (legacy.passed !== shadow.passed) {
    return legacy.passed ? "legacyPassedShadowFailed" : "legacyFailedShadowPassed";
  }
  if (!sameRow(legacy.userValue, shadow.userValue)) {
    return "userValueRowChanged";
  }
  return undefined;
}

/**
 * `undefined` when the two engines agree — the common case, and the one the
 * parity tests pin. Otherwise a bounded, content-free payload.
 */
export function buildShadowMismatch(
  legacy: ShadowMismatchLegacySide,
  shadow: ShadowMismatchShadowSide
): ShadowMismatch | undefined {
  const mismatchKind = classify(legacy, shadow);
  if (!mismatchKind) return undefined;
  const version = resolveAppVersion();
  return {
    runId: legacy.runId,
    iterationId: legacy.iterationId,
    ...(legacy.caseKey ? { caseKeyHash: sha256Hex(legacy.caseKey) } : {}),
    legacyPassed: legacy.passed,
    shadowPassed: shadow.passed,
    ...(legacy.userValue?.state
      ? { legacyUserValueState: legacy.userValue.state }
      : {}),
    ...(legacy.userValue?.reason
      ? { legacyUserValueReason: legacy.userValue.reason }
      : {}),
    ...(shadow.userValue?.state
      ? { shadowUserValueState: shadow.userValue.state }
      : {}),
    ...(shadow.userValue?.reason
      ? { shadowUserValueReason: shadow.userValue.reason }
      : {}),
    ...(legacy.failureCategory
      ? { legacyFailureCategory: legacy.failureCategory }
      : {}),
    ...(shadow.failureCategory
      ? { shadowFailureCategory: shadow.failureCategory }
      : {}),
    mismatchKind,
    ...(shadow.disagreeingScorerIds?.length
      ? { disagreeingScorerIds: [...shadow.disagreeingScorerIds] }
      : {}),
    ...(shadow.definitionHash ? { definitionHash: shadow.definitionHash } : {}),
    ...(shadow.evaluationConfigHash
      ? { evaluationConfigHash: shadow.evaluationConfigHash }
      : {}),
    ...(shadow.judgeTemplateVersion !== undefined
      ? { judgeTemplateVersion: shadow.judgeTemplateVersion }
      : {}),
    ...(shadow.judgeTemplateHash
      ? { judgeTemplateHash: shadow.judgeTemplateHash }
      : {}),
    ...(shadow.stageAnalyzerVersion !== undefined
      ? { stageAnalyzerVersion: shadow.stageAnalyzerVersion }
      : legacy.stageAnalyzerVersion !== undefined
        ? { stageAnalyzerVersion: legacy.stageAnalyzerVersion }
        : {}),
    mode: shadow.mode,
    ...(version ? { inspectorVersion: version } : {}),
    deployment: HOSTED_MODE ? "hosted" : "self_hosted",
  };
}

/** Per-run emission state: the dedupe set plus the cap bookkeeping. */
type RunEmissionState = { seen: Set<string>; emitted: number; truncated: boolean };

const runStates = new Map<string, RunEmissionState>();

function stateFor(runId: string): RunEmissionState {
  const existing = runStates.get(runId);
  if (existing) return existing;
  const created: RunEmissionState = {
    seen: new Set<string>(),
    emitted: 0,
    truncated: false,
  };
  runStates.set(runId, created);
  return created;
}

/**
 * Emit one mismatch, subject to dedupe and the per-run cap. Returns true when a
 * payload was actually emitted.
 *
 * Agreement never reaches here: pass the result of `buildShadowMismatch`, and
 * `undefined` is a no-op by construction.
 */
export function emitShadowMismatch(
  mismatch: ShadowMismatch | undefined
): boolean {
  if (!mismatch) return false;
  const state = stateFor(mismatch.runId);
  const key = `${mismatch.iterationId}:${mismatch.mismatchKind}`;
  if (state.seen.has(key)) return false;
  state.seen.add(key);
  if (state.emitted >= MAX_SHADOW_MISMATCHES_PER_RUN) {
    if (!state.truncated) {
      state.truncated = true;
      logger.warn("grading_shadow_mismatch_truncated", {
        runId: mismatch.runId,
        mode: mismatch.mode,
        cap: MAX_SHADOW_MISMATCHES_PER_RUN,
      });
    }
    return false;
  }
  state.emitted += 1;
  logger.warn("grading_shadow_mismatch", { ...mismatch });
  return true;
}

/** Drop a finished run's bookkeeping so the map cannot grow unbounded. */
export function forgetShadowMismatchRun(runId: string): void {
  runStates.delete(runId);
}

/** Test-only reset of all per-run state. */
export function resetShadowMismatchStateForTests(): void {
  runStates.clear();
}
