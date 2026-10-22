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
import { MANAGED_DEFAULT_JUDGE_MODEL } from "@/components/shared/session-quality/judge-config";
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";
import { CHOOSE_ORG_JUDGE_MODEL } from "@/components/evals/judge-model-picker";
import { ORG_KEYS_MODEL_REASON } from "@/lib/org-keys-refusal";
import {
  classifyModelIdProvider,
  isRuntimeChosenModelSentinel,
} from "@/shared/model-provider";
import { isMCPJamProvidedModel } from "@/shared/types";
import {
  harnessDisplayName,
  harnessNoRunnableModelReason,
  harnessOrgUpstream,
  harnessRunsOnOrgProvider,
} from "@/shared/harness-model-support";
import type { EvalSuite } from "../evals/types";

export type PreflightModel = {
  model: string;
  provider: string;
  /** The saved selection beside a case model, when it has one. */
  selection?: PreflightSelection | null;
  /** False only for an inherited client selection the browser cannot resolve. */
  selectionKnown?: boolean;
  /**
   * The harness the cell's client runs (`claude-code`, `codex`), when it
   * runs one. Absent: an emulated client, or a model with no client.
   */
  harness?: string | null;
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
  harness?: string | null;
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
 * The judge a launch requires: `default` grades on the platform default (none
 * while the organization requires its own keys: a judge must be chosen);
 * `explicit` names a saved model.
 */
export type PreflightJudge =
  | { kind: "default" }
  | {
      kind: "explicit";
      modelId: string;
      selection?: PreflightSelection | null;
    };

/**
 * The problem for a required judge nobody chose, under the policy: the same
 * sentence as the judge picker's unset trigger and the backend's refusal.
 */
export { CHOOSE_ORG_JUDGE_MODEL };

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
 * The provider of the organization connection a model runs on, or undefined
 * when it is not an organization model (MCPJam-provided, personal or local).
 * A legacy id with no selection reads as the provider it names; whether it
 * can run is `orgKeyModelProblem`'s to say.
 */
function orgModelVendor(
  orgConfig: PreflightOrgConfig,
  model: PreflightModel,
): string | undefined {
  const source = model.selection?.source;
  if (source === "org") {
    const id = model.selection?.connectionRef?.id;
    const connection = id
      ? orgConfig.providers.find((provider) => provider.id === id)
      : undefined;
    return connection?.providerKey ?? model.provider;
  }
  if (source === "legacy") return model.provider;
  if (source) return undefined;
  return isMCPJamProvidedModel(model.model, model.provider)
    ? undefined
    : model.provider;
}

/**
 * A harness with no organization-key path (Cursor, which runs on the
 * customer's own Cursor account) can't run while the organization requires
 * its own keys, whatever its model, Cursor Auto included: the backend refuses
 * every such runtime (`org_runtime_unsupported`). One sentence per harness,
 * however many of its cells the launch has.
 */
function orgKeyRuntimeProblem(model: PreflightModel): string | null {
  const harnessId = model.harness;
  if (!harnessId || harnessOrgUpstream(harnessId)) return null;
  return `${harnessDisplayName(harnessId)} can't run on an organization's providers, so it is unavailable while the organization requires its own keys. Choose another client for this run.`;
}

/**
 * A harness that runs on an organization's key (Claude Code, Codex) runs
 * under the policy only on an organization connection to its own vendor
 * (Claude Code: Anthropic, Codex: OpenAI). A model on such a client that is
 * not one gets this problem, which names the vendor the harness needs. A
 * matching organization model gets none here: whether its connection can
 * run is `orgKeyModelProblem`'s to say. An emulated client never gets one,
 * and a harness on its own account (Cursor) gets `orgKeyRuntimeProblem`'s.
 */
function orgKeyHarnessProblem(
  orgConfig: PreflightOrgConfig,
  model: PreflightModel,
  label: string,
): string | null {
  if (model.selectionKnown === false) return null;
  const harnessId = model.harness;
  if (!harnessId || !harnessOrgUpstream(harnessId)) return null;
  if (harnessRunsOnOrgProvider(harnessId, orgModelVendor(orgConfig, model))) {
    return null;
  }
  const reason = harnessNoRunnableModelReason(harnessId, {
    requireOrgKeys: true,
  });
  return `${label} can't run on ${harnessDisplayName(harnessId)}. ${reason}`;
}

function orgKeyJudgeProblem(
  orgConfig: PreflightOrgConfig,
  judge: PreflightJudge,
): string | null {
  // No default judge runs on the organization's keys: a person picks one.
  if (judge.kind === "default") return CHOOSE_ORG_JUDGE_MODEL;
  return orgKeyModelProblem(
    orgConfig,
    {
      model: judge.modelId,
      provider:
        classifyModelIdProvider(judge.modelId)?.provider ??
        judge.modelId.split("/")[0] ??
        "",
      selection: judge.selection ?? { source: "hosted" },
    },
    "The judge",
  );
}

/**
 * Every required dependency of a launch that can't run on the organization's
 * providers, once each: each model (a harness client's first: a harness
 * with no organization-key path, else the vendor it needs), then the judge.
 */
export function orgKeyProblemsOf(
  orgConfig: PreflightOrgConfig,
  models: readonly PreflightModel[],
  judge?: PreflightJudge,
): string[] {
  const problems = new Set<string>();
  for (const model of models) {
    // Before the sentinel skip below: Cursor Auto names no model, and its
    // runtime is refused all the same.
    const runtimeProblem = orgKeyRuntimeProblem(model);
    if (runtimeProblem) {
      problems.add(runtimeProblem);
      continue;
    }
    if (
      !model.provider ||
      model.provider === "none" ||
      isRuntimeChosenModelSentinel(model.model)
    )
      continue;
    const problem =
      orgKeyHarnessProblem(orgConfig, model, model.model) ??
      orgKeyModelProblem(orgConfig, model, model.model);
    if (problem) problems.add(problem);
  }
  const judgeProblem = judge ? orgKeyJudgeProblem(orgConfig, judge) : null;
  if (judgeProblem) problems.add(judgeProblem);
  return [...problems];
}

/**
 * The judge a launch of this suite requires, as the backend's launch
 * preflight reads it: whenever grading is on and either automatic or
 * required. Unset fields resolve to the backend's defaults, and grading is on
 * and automatic by default, so a suite that never touched its judge settings
 * still needs one. Under the policy that judge must be chosen: there is no
 * default judge on the organization's keys.
 */
export function preflightJudgeOf(
  suite: Pick<EvalSuite, "judgeConfig">,
): PreflightJudge | undefined {
  const goal = suite.judgeConfig?.goalCompletion;
  if (!(goal?.enabled ?? GOAL_COMPLETION_DEFAULTS.enabled)) return undefined;
  // `gating` is the legacy spelling of `required`.
  const required =
    (goal?.autoRun ?? GOAL_COMPLETION_DEFAULTS.autoRun) ||
    goal?.role === "gating" ||
    goal?.role === "required";
  if (!required) return undefined;
  const selection = goal?.judgeSelection as PreflightSelection | undefined;
  // A slot saved with its selection alone grades the selection's model.
  const modelId = goal?.judgeModel?.trim() || selection?.modelId?.trim() || "";
  if (!modelId) return { kind: "default" };
  if (selection?.source === "org") {
    return { kind: "explicit", modelId, selection };
  }
  if (modelId === MANAGED_DEFAULT_JUDGE_MODEL) {
    return { kind: "default" };
  }
  return { kind: "explicit", modelId, selection: selection ?? null };
}
