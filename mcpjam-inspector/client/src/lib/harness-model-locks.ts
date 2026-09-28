/**
 * Picker-side reading of the harness × model evidence table
 * (`shared/harness-model-support.ts`) — the SAME table, at the SAME pinned
 * runtime versions, the server's pre-flight and eval admission read. A picker
 * that offered a model the server then refused would only move the failure to
 * run time; one that hid it without saying why would look like a missing model.
 * So an incompatible row stays listed, disabled, with the server's own reason.
 */
import {
  harnessModelSupport,
  harnessModelVerdictAdmits,
  harnessPinnedVersion,
  type HarnessModelPurpose,
} from "@/shared/harness-model-support";
import type { ModelDefinition } from "@/shared/types";

/** A host that runs a harness, and (optionally) the runtime version it runs.
 *  Absent version ⇒ the adapter's pinned version. */
export type HarnessModelTarget = {
  harnessId: string;
  runtimeVersion?: string | null;
};

function runtimeVersionOf(target: HarnessModelTarget): string | undefined {
  return target.runtimeVersion ?? harnessPinnedVersion(target.harnessId);
}

/**
 * Why `modelId` cannot run on `target` for `purpose`, or undefined when it can.
 * `null` / undefined target = an emulated host, which runs any model.
 */
export function harnessModelRefusalReason(
  modelId: string,
  target: HarnessModelTarget | null | undefined,
  purpose: HarnessModelPurpose,
): string | undefined {
  if (!target) return undefined;
  const verdict = harnessModelSupport({
    harnessId: target.harnessId,
    runtimeVersion: runtimeVersionOf(target),
    modelId,
  });
  return harnessModelVerdictAdmits(verdict, purpose)
    ? undefined
    : verdict.reason;
}

/**
 * The lock for a picker whose choice applies to SEVERAL hosts at once (the
 * composer's shared model axis): a model is disabled only when EVERY host
 * refuses it. When some hosts can run it, it stays pickable and the cells the
 * other hosts cannot run are skipped at resolve time (`expandModelChoices`),
 * where they are reported rather than silently dropped.
 */
export function harnessModelLockReason(
  modelId: string,
  targets: ReadonlyArray<HarnessModelTarget | null | undefined>,
  purpose: HarnessModelPurpose,
): string | undefined {
  if (targets.length === 0) return undefined;
  let firstReason: string | undefined;
  for (const target of targets) {
    const reason = harnessModelRefusalReason(modelId, target, purpose);
    if (reason === undefined) return undefined;
    firstReason ??= reason;
  }
  return firstReason;
}

/**
 * Mark every model the targets cannot run as disabled, with the reason. Rows
 * already disabled for another reason (credits, guest lock) keep theirs.
 */
export function applyHarnessModelLocks(
  models: ModelDefinition[],
  targets: ReadonlyArray<HarnessModelTarget | null | undefined>,
  purpose: HarnessModelPurpose,
): ModelDefinition[] {
  if (!targets.some(Boolean)) return models;
  return models.map((model) => {
    if (model.disabled) return model;
    const reason = harnessModelLockReason(String(model.id), targets, purpose);
    return reason
      ? { ...model, disabled: true, disabledReason: reason }
      : model;
  });
}
