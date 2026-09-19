import { canonicalDigest } from "./contract/canonical.js";
import {
  errorScoreResult,
  finalizeScoreResult,
  resolveScoreDefinition,
  skippedScoreResult,
} from "./contract/derive.js";
import {
  MAX_SCORER_ID_LENGTH,
  MAX_RATIONALE_LENGTH,
} from "./contract/types.js";
import type { ResolvedScoreDefinition, ScoreResult } from "./contract/types.js";

export const MAX_REPORTED_MEASUREMENTS = 100;
export interface ReportedMeasurement {
  id: string;
  version: string;
  label?: string;
  passThreshold?: number;
}
export interface EvalExecutionContext {
  readonly signal: AbortSignal;
  /** Report a declared measurement for this attempt. Reports after closure are ignored. */
  report(id: string, value: boolean | number): void;
}
export interface ReportedEvidence {
  id: string;
  value?: number;
  invalid?: true;
  duplicates: number;
  attempt: number;
}

export function reportedDefinitions(
  declarations: readonly ReportedMeasurement[]
): ResolvedScoreDefinition[] {
  if (declarations.length > MAX_REPORTED_MEASUREMENTS)
    throw new Error(
      `At most ${MAX_REPORTED_MEASUREMENTS} reported measurements may be declared`
    );
  const ids = new Set<string>();
  return declarations.map((declaration) => {
    const { id, version, label, passThreshold = 1 } = declaration;
    if (
      !id ||
      id.length > MAX_SCORER_ID_LENGTH ||
      !/^[A-Za-z0-9_.:-]+$/.test(id)
    )
      throw new Error(
        "Reported measurement id must be a stable URL-safe identifier (max 128 characters)"
      );
    if (ids.has(id))
      throw new Error(`Duplicate reported measurement id "${id}"`);
    ids.add(id);
    if (!version?.trim() || version.length > 128)
      throw new Error(
        "Reported measurement version must be non-empty (max 128 characters)"
      );
    if (label !== undefined && label.length > MAX_RATIONALE_LENGTH)
      throw new Error("Reported measurement label is too long");
    if (
      !Number.isFinite(passThreshold) ||
      passThreshold < 0 ||
      passThreshold > 1
    )
      throw new Error("Reported measurement passThreshold must be in [0,1]");
    return resolveScoreDefinition({
      scorerId: id,
      idSource: "explicit",
      scorerVersion: version,
      implementationHash: canonicalDigest({
        kind: "reported-measurement",
        version,
        passThreshold,
      }),
      label,
      role: "advisory",
      deterministic: true,
      passThreshold,
    });
  });
}

export function captureReportedMeasurements(
  declarations: readonly ReportedMeasurement[],
  signal: AbortSignal,
  attempt: number
) {
  const ids = new Set(declarations.map((declaration) => declaration.id));
  const values = new Map<string, ReportedEvidence>();
  let closed = false;
  const context: EvalExecutionContext = Object.freeze({
    signal,
    report(id: string, value: boolean | number) {
      if (closed || signal.aborted) return;
      if (!ids.has(id))
        throw new Error(
          `Undeclared reported measurement "${id}"; add it to the case's reported declarations`
        );
      const number = typeof value === "boolean" ? Number(value) : value;
      const duplicates = values.has(id) ? values.get(id)!.duplicates + 1 : 0;
      values.set(id, {
        id,
        attempt,
        duplicates,
        ...(typeof number !== "number" ||
        !Number.isFinite(number) ||
        number < 0 ||
        number > 1
          ? { invalid: true as const }
          : { value: number }),
      });
    },
  });
  return {
    context,
    close(): readonly ReportedEvidence[] {
      closed = true;
      return Object.freeze(
        [...values.values()].map((value) => Object.freeze({ ...value }))
      );
    },
  };
}

export function evaluateReportedMeasurements(
  definitions: readonly ResolvedScoreDefinition[],
  evidence: readonly ReportedEvidence[]
): ScoreResult[] {
  const values = new Map(evidence.map((value) => [value.id, value]));
  return definitions.map((definition) => {
    const observation = values.get(definition.scorerId);
    if (!observation)
      return skippedScoreResult(
        definition,
        "Declared measurement was not reported in the final attempt"
      );
    if (observation.invalid)
      return errorScoreResult(
        definition,
        new Error(
          "Reported measurement must be a boolean or finite number in [0,1]"
        )
      );
    return finalizeScoreResult(definition, {
      kind: "scored",
      value: observation.value!,
      rationale: `Reported in attempt ${observation.attempt + 1}${observation.duplicates ? `; ${observation.duplicates} duplicate report(s), last value retained` : ""}`,
    });
  });
}
