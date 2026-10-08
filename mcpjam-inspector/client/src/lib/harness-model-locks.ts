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
import { isMCPJamProvidedModelMenuItem } from "@/components/chat-v2/shared/model-helpers";

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

/**
 * The models a harness host's chat picker OFFERS: only the ones its runtime
 * can run. Unlike `applyHarnessModelLocks` (a shared axis across several
 * hosts, where a row one host refuses may still suit another), a single
 * harness host has nothing to gain from rows it would refuse, and offering
 * them is how a Codex client ended up on Claude Haiku.
 *
 * Kept: MCPJam-provided rows (a harness turn refuses any other, the server's
 * `model-not-hosted`) that the evidence table admits for chat. A row the table
 * has not verified (`unknown`) stays, with its reason as a warning, because
 * the server runs it in chat with the same warning. Nothing runnable in the
 * catalog (Cursor, whose account picks its own model) leaves the list as it
 * was rather than empty; the server's refusal then says why.
 */
export function harnessPickerModels(
  models: ModelDefinition[],
  target: HarnessModelTarget | null | undefined,
): ModelDefinition[] {
  if (!target) return models;
  const kept: ModelDefinition[] = [];
  for (const model of models) {
    if (!isMCPJamProvidedModelMenuItem(model)) continue;
    const verdict = harnessModelSupport({
      harnessId: target.harnessId,
      runtimeVersion: runtimeVersionOf(target),
      modelId: String(model.id),
    });
    if (!harnessModelVerdictAdmits(verdict, "chat")) continue;
    kept.push(
      verdict.status === "unknown" && !model.warningReason
        ? { ...model, warningReason: verdict.reason }
        : model,
    );
  }
  return kept.length > 0 ? kept : models;
}

/**
 * The model a harness host starts on when nothing selected is runnable: the
 * host's own model if it is offered and enabled, else the first enabled row
 * the evidence table fully supports, else the first enabled row. Never the
 * emulated default (`getDefaultModel`), whose first choice is a Claude model.
 */
export function harnessDefaultModel(
  models: ModelDefinition[],
  target: HarnessModelTarget,
  preferredModelId?: string | null,
): ModelDefinition | undefined {
  const enabled = models.filter((model) => !model.disabled);
  const preferred = preferredModelId
    ? enabled.find((model) => String(model.id) === preferredModelId)
    : undefined;
  if (preferred) return preferred;
  const supported = enabled.find(
    (model) =>
      harnessModelSupport({
        harnessId: target.harnessId,
        runtimeVersion: runtimeVersionOf(target),
        modelId: String(model.id),
      }).status === "supported",
  );
  return supported ?? enabled[0];
}
