/**
 * Picker-side reading of the harness × model evidence table
 * (`shared/harness-model-support.ts`) — the SAME table, at the SAME pinned
 * runtime versions, the server's pre-flight and eval admission read. A picker
 * that offered a model the server then refused would only move the failure to
 * run time; one that hid it without saying why would look like a missing model.
 * So an incompatible row stays listed, disabled, with the server's own reason.
 *
 * Whose key pays is decided first, per ROW: a brokered harness (Claude Code,
 * Codex) runs an MCPJam-provided row on MCPJam's key, or a row from an
 * organization connection on its own vendor (Claude Code → Anthropic, Codex →
 * OpenAI) on the organization's key — read on the canonical id that row's
 * saved selection names. Any other row (a key on this machine, an org
 * connection to another vendor) is refused, exactly as the server refuses it.
 */
import type { ModelSelection } from "@mcpjam/sdk/browser";
import {
  HARNESS_ORG_PROVIDER_KEYS,
  harnessModelSupport,
  harnessModelVerdictAdmits,
  harnessOrgProviderUnsupportedReason,
  harnessPinnedVersion,
  harnessRunsOnOrgProvider,
  type HarnessModelPurpose,
} from "@/shared/harness-model-support";
import type { ModelDefinition } from "@/shared/types";
import { isMCPJamProvidedModelMenuItem } from "@/components/chat-v2/shared/model-helpers";
import {
  canonicalSelectionModelId,
  modelRowKey,
  providerKeyForModelDefinition,
} from "@/components/chat-v2/shared/model-selection";

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

/** Does this harness run on an organization's own provider key at all? */
function harnessTakesOrgKeys(harnessId: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(
      HARNESS_ORG_PROVIDER_KEYS,
      harnessId,
    ) &&
    HARNESS_ORG_PROVIDER_KEYS[
      harnessId as keyof typeof HARNESS_ORG_PROVIDER_KEYS
    ].length > 0
  );
}

/**
 * The id the evidence table reads for a picker ROW on `target`, or why the row
 * cannot run there at all. See the module comment for the rule.
 *
 * A harness that never takes an org key (Cursor, which runs on the customer's
 * own Cursor account) reads the table alone, exactly as before.
 */
export function harnessRowModelId(
  model: ModelDefinition,
  target: HarnessModelTarget,
):
  | { modelId: string; rail: "hosted" | "org" | "evidence" }
  | { refusal: string } {
  if (!harnessTakesOrgKeys(target.harnessId)) {
    return { modelId: String(model.id), rail: "evidence" };
  }
  if (isMCPJamProvidedModelMenuItem(model)) {
    return { modelId: String(model.id), rail: "hosted" };
  }
  if (
    model.orgProvider &&
    harnessRunsOnOrgProvider(
      target.harnessId,
      providerKeyForModelDefinition(model),
    )
  ) {
    // The canonical id its saved selection names — the id the server reads
    // the table on. A row that cannot form one cannot be routed to the org
    // key, so the server would refuse it.
    const canonical = canonicalSelectionModelId(model);
    return canonical
      ? { modelId: canonical, rail: "org" }
      : { refusal: harnessOrgProviderUnsupportedReason(target.harnessId) };
  }
  return { refusal: harnessOrgProviderUnsupportedReason(target.harnessId) };
}

/**
 * Why a picker ROW cannot run on `target` for `purpose`, or undefined when it
 * can. `null` / undefined target = an emulated host, which runs any model.
 */
export function harnessRowRefusalReason(
  model: ModelDefinition,
  target: HarnessModelTarget | null | undefined,
  purpose: HarnessModelPurpose,
): string | undefined {
  if (!target) return undefined;
  const row = harnessRowModelId(model, target);
  if ("refusal" in row) return row.refusal;
  return harnessModelRefusalReason(row.modelId, target, purpose);
}

/**
 * Why a SAVED choice (an id and, when it has one, its selection) cannot run on
 * `target` — for a surface that holds choices rather than picker rows (the
 * composer's resolve, `expandModelChoices`). A local selection never runs on a
 * brokered harness; an org selection runs only on the harness's own vendor,
 * read from its canonical id's prefix (the server, which knows the
 * connection's provider, re-checks at admission).
 */
export function harnessChoiceRefusalReason(
  choice: {
    modelId: string;
    selection?: Pick<ModelSelection, "source"> | null;
  },
  target: HarnessModelTarget | null | undefined,
  purpose: HarnessModelPurpose,
): string | undefined {
  if (!target) return undefined;
  if (harnessTakesOrgKeys(target.harnessId)) {
    const source = choice.selection?.source;
    if (source === "local") {
      return harnessOrgProviderUnsupportedReason(target.harnessId);
    }
    if (source === "org") {
      const slash = choice.modelId.indexOf("/");
      const vendor = slash > 0 ? choice.modelId.slice(0, slash) : undefined;
      if (!harnessRunsOnOrgProvider(target.harnessId, vendor)) {
        return harnessOrgProviderUnsupportedReason(target.harnessId);
      }
    }
  }
  return harnessModelRefusalReason(choice.modelId, target, purpose);
}

/**
 * The lock for a picker whose choice applies to SEVERAL hosts at once (the
 * composer's shared model axis): a row is disabled only when EVERY host
 * refuses it. When some hosts can run it, it stays pickable and the cells the
 * other hosts cannot run are skipped at resolve time (`expandModelChoices`),
 * where they are reported rather than silently dropped.
 */
export function harnessModelLockReason(
  model: ModelDefinition,
  targets: ReadonlyArray<HarnessModelTarget | null | undefined>,
  purpose: HarnessModelPurpose,
): string | undefined {
  if (targets.length === 0) return undefined;
  let firstReason: string | undefined;
  for (const target of targets) {
    const reason = harnessRowRefusalReason(model, target, purpose);
    if (reason === undefined) return undefined;
    firstReason ??= reason;
  }
  return firstReason;
}

/**
 * Mark every row the targets cannot run as disabled, with the reason. Rows
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
    const reason = harnessModelLockReason(model, targets, purpose);
    return reason
      ? { ...model, disabled: true, disabledReason: reason }
      : model;
  });
}

/** {@link harnessModelLockReason} for every row, keyed by `modelRowKey`. */
export function harnessModelLockReasonsByRow(
  models: readonly ModelDefinition[],
  targets: ReadonlyArray<HarnessModelTarget | null | undefined>,
  purpose: HarnessModelPurpose,
): Map<string, string> {
  const byRow = new Map<string, string>();
  if (targets.length === 0) return byRow;
  for (const model of models) {
    const reason = harnessModelLockReason(model, targets, purpose);
    if (reason) byRow.set(modelRowKey(model), reason);
  }
  return byRow;
}

/**
 * The models a harness host's chat picker OFFERS: only the ones its runtime
 * can run. Unlike `applyHarnessModelLocks` (a shared axis across several
 * hosts, where a row one host refuses may still suit another), a single
 * harness host has nothing to gain from rows it would refuse, and offering
 * them is how a Codex client ended up on Claude Haiku.
 *
 * Kept, for a brokered harness: MCPJam-provided rows, and rows from an
 * organization connection on the harness's own vendor (run on the org's key),
 * that the evidence table admits for chat on their canonical id. Every other
 * row is refused by the server, so it is not offered. A row the table has not
 * verified (`unknown`) stays, with its reason as a warning, because the server
 * runs it in chat with the same warning. Nothing runnable leaves the list
 * EMPTY — the picker's empty state — never the unfiltered list, which would
 * offer only rows the server refuses.
 *
 * A harness that never takes an org key (Cursor, whose account picks its own
 * model and ignores the turn's) keeps the list as it was when nothing in it
 * is runnable: there the turn's model is not what runs.
 */
export function harnessPickerModels(
  models: ModelDefinition[],
  target: HarnessModelTarget | null | undefined,
): ModelDefinition[] {
  if (!target) return models;
  const kept: ModelDefinition[] = [];
  for (const model of models) {
    const row = harnessRowModelId(model, target);
    if ("refusal" in row) continue;
    if (row.rail === "evidence" && !isMCPJamProvidedModelMenuItem(model)) {
      continue;
    }
    const verdict = harnessModelSupport({
      harnessId: target.harnessId,
      runtimeVersion: runtimeVersionOf(target),
      modelId: row.modelId,
    });
    if (!harnessModelVerdictAdmits(verdict, "chat")) continue;
    kept.push(
      verdict.status === "unknown" && !model.warningReason
        ? { ...model, warningReason: verdict.reason }
        : model,
    );
  }
  if (kept.length > 0 || harnessTakesOrgKeys(target.harnessId)) return kept;
  return models;
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
  const supported = enabled.find((model) => {
    const row = harnessRowModelId(model, target);
    return (
      !("refusal" in row) &&
      harnessModelSupport({
        harnessId: target.harnessId,
        runtimeVersion: runtimeVersionOf(target),
        modelId: row.modelId,
      }).status === "supported"
    );
  });
  return supported ?? enabled[0];
}
