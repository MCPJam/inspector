/**
 * The run sheet's checks while the organization requires its own provider
 * keys ("Use your keys for all AI features"): which required AI dependencies
 * of a launch can't run on the organization's providers. The backend refuses
 * the same launch; this lets the sheet say so before Start.
 *
 * Kept apart from `suite-run-preflight.tsx`, which composes these problems
 * with the server and environment checks.
 */
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { isUsableOrgConnection } from "@/components/chat-v2/shared/org-ai-policy";
import { ORG_KEYS_MODEL_REASON } from "@/lib/org-keys-refusal";
import { isRuntimeChosenModelSentinel } from "@/shared/model-provider";
import { isMCPJamProvidedModel } from "@/shared/types";

export type PreflightModel = {
  model: string;
  provider: string;
  /** The saved selection beside a case model, when it has one. */
  selection?: PreflightSelection | null;
  /** False only for an inherited client selection the browser cannot resolve. */
  selectionKnown?: boolean;
};

export type PreflightSelection = {
  modelId?: string;
  source?: string;
  connectionRef?: { kind?: string; id?: string } | null;
};

export type PreflightHost = {
  hostId: string;
  modelId?: string | null;
  modelSelection?: PreflightSelection | null;
  selectionKnown?: boolean;
};

/** Unknown client selections are left to the backend's launch checks. */
export function hostsForPreflight(
  hosts: readonly PreflightHost[],
  resolvedSelections?: Readonly<Record<string, PreflightSelection>>,
): PreflightHost[] {
  return hosts.map((host) => {
    const selection = resolvedSelections?.[host.hostId] ?? host.modelSelection;
    const selectionKnown =
      Boolean(host.modelId) && selection?.modelId === host.modelId;
    return {
      ...host,
      ...(selectionKnown ? { modelSelection: selection } : {}),
      selectionKnown,
    };
  });
}

export type PreflightOrgConfig = {
  providers: Array<
    Pick<OrgModelProvider, "providerKey" | "enabled"> &
      Partial<Pick<OrgModelProvider, "id" | "hasSecret" | "policyEligibility">>
  >;
  aiKeyPolicy?: OrgVisibleConfig["aiKeyPolicy"];
  aiReadiness?: OrgVisibleConfig["aiReadiness"];
};

/**
 * Whether a connection matching `predicate` is usable under the policy:
 * enabled, with a saved key where its provider needs one, and one the backend
 * calls eligible (`policyEligibility`). The sheet only reads the verdict; a
 * connection without one (an older backend) is not eligible.
 */
function eligibleConnection(
  orgConfig: PreflightOrgConfig,
  predicate: (provider: PreflightOrgConfig["providers"][number]) => boolean,
): boolean {
  return orgConfig.providers.some(
    (provider) => predicate(provider) && isUsableOrgConnection(provider, true),
  );
}

/**
 * Whether a saved model can run while the organization requires its own
 * keys: only an org selection on an eligible connection can. Hosted and
 * personal-key models never can, and neither can a legacy id (a model saved
 * with no selection): the backend reads it as `{ source: "legacy" }` and
 * refuses it (`org_keys_required`), even when an eligible connection serves
 * its provider. That case gets its own sentence, since the model itself is
 * one the organization offers.
 */
function orgKeyModelProblem(
  orgConfig: PreflightOrgConfig,
  model: PreflightModel,
  label: string,
): string | null {
  if (model.selectionKnown === false) return null;
  const source = model.selection?.source;
  if (source === "org") {
    const id = model.selection?.connectionRef?.id;
    return id && eligibleConnection(orgConfig, (provider) => provider.id === id)
      ? null
      : `${label} uses an organization provider connection that can't run it while the organization requires its own keys. ${ORG_KEYS_MODEL_REASON}`;
  }
  if (
    source === "hosted" ||
    (!source && isMCPJamProvidedModel(model.model, model.provider))
  ) {
    return `${label} is an MCPJam-provided model, which this organization doesn't allow. ${ORG_KEYS_MODEL_REASON}`;
  }
  if (
    source === "legacy" ||
    (!source &&
      eligibleConnection(
        orgConfig,
        (provider) => provider.providerKey === model.provider,
      ))
  ) {
    return `${label} isn't saved with an organization provider connection, which this organization requires. ${ORG_KEYS_MODEL_REASON}`;
  }
  return `${label} runs on a personal or local key, which this organization doesn't allow. ${ORG_KEYS_MODEL_REASON}`;
}

/**
 * Every required dependency of a launch that can't run on the organization's
 * providers, once each: each model it runs.
 */
export function orgKeyProblemsOf(
  orgConfig: PreflightOrgConfig,
  models: readonly PreflightModel[],
): string[] {
  const problems = new Set<string>();
  for (const model of models) {
    if (
      !model.provider ||
      model.provider === "none" ||
      isRuntimeChosenModelSentinel(model.model)
    )
      continue;
    const problem = orgKeyModelProblem(orgConfig, model, model.model);
    if (problem) problems.add(problem);
  }
  return [...problems];
}
