import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { HostListItem } from "@/hooks/useClients";
import type { HostSlot } from "@/hooks/use-playground-host-slots";
import type { ComparePaneEnvironment } from "@/hooks/use-compare-environment-panes";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { findModelForStoredChoice } from "@/components/chat-v2/shared/model-selection";
import { resolveCompareSelectionRow } from "@/lib/compare-cards";
import { paneTargetKey } from "@/lib/compare-panes";
import { describeEnvironmentError } from "@/lib/environment-error";
import { harnessPickerModels } from "@/lib/harness-model-locks";
import { snapshotFromHostConfig } from "@/lib/host-snapshot";
import type { PlaygroundClientResolution } from "@/lib/playground-client-columns";
import { runtimeChosenModelRow } from "@/lib/runtime-chosen-model";
import {
  effectiveHarnessId,
  harnessAccountChoosesModel,
} from "@/shared/harness-descriptors";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";
import type { ModelDefinition } from "@/shared/types";

/**
 * Resolve a pane that runs a named environment. The environment names its
 * client and model; the pane shows that model without sending it, so the
 * server runs the environment as saved, unless someone picked another model
 * in the pane. It never falls back to the client's own setup: anything that
 * keeps the environment from running leaves the pane blocked, with the reason.
 */
export function resolveEnvironmentPaneColumn({
  paneId,
  environment,
  slot,
  hosts,
  models,
  orgConfig,
  pickedSelection,
}: {
  paneId: string;
  environment: ComparePaneEnvironment;
  slot: HostSlot | undefined;
  hosts: readonly HostListItem[];
  models: readonly ModelDefinition[];
  orgConfig?: OrgVisibleConfig;
  pickedSelection?: ModelSelection;
}): PlaygroundClientResolution {
  const { environmentId, preview, visible } = environment;
  const hostId = preview?.host.hostId ?? "";
  const identity = {
    compareId: paneId,
    hostId,
    targetKey: paneTargetKey({ kind: "environment", environmentId }),
    environmentId,
    compareLabel: visible ? (preview?.environment.name ?? "Environment") : "Saved setup",
  };
  if (visible === undefined)
    return { ...identity, status: "loading", reason: "Loading setup…" };
  if (!visible)
    return {
      ...identity,
      status: "unavailable",
      reason:
        "This setup is unavailable. Choose a client in pane settings.",
    };
  if (environment.isLoading)
    return { ...identity, status: "loading", reason: "Loading environment…" };
  if (environment.error || !preview)
    return {
      ...identity,
      status: "unavailable",
      reason: describeEnvironmentError(environment.error).oneLine,
    };
  const host = slot?.host?.hostId === hostId ? slot.host : null;
  if (!host)
    return {
      ...identity,
      status: slot?.isLoading ? "loading" : "unavailable",
      reason: slot?.isLoading
        ? "Loading saved configuration…"
        : `${hosts.find((item) => item.hostId === hostId)?.name ?? "This environment's client"} is unavailable. Choose another client or environment in pane settings.`,
    };
  const config = host.config;
  const harnessId = effectiveHarnessId(config);
  const accountChosen = harnessAccountChoosesModel(harnessId)
    ? runtimeChosenModelRow(preview.host.modelId ?? "")
    : undefined;
  const modelRows = accountChosen
    ? []
    : harnessPickerModels([...models], harnessId ? { harnessId } : null, {
        requireOrgKeys: orgRequiresOwnKeys(orgConfig),
      });
  const picked = accountChosen ? undefined : pickedSelection;
  const inherited = preview.host.modelSelection ?? undefined;
  const model =
    accountChosen ??
    (picked
      ? resolveCompareSelectionRow(picked, modelRows, orgConfig)
      : inherited
        ? resolveCompareSelectionRow(inherited, modelRows, orgConfig)
        : findModelForStoredChoice(
            { modelId: preview.host.modelId ?? "" },
            modelRows,
            orgConfig,
          ));
  if (!model || (model.disabled && !accountChosen))
    return {
      ...identity,
      status: "unavailable",
      reason:
        "This pane's model is unavailable. Choose another in pane settings.",
      ...(model ? { model } : {}),
      hostConfig: config,
      modelRows,
    };
  return {
    status: "ready",
    column: {
      ...identity,
      compareKind: "host",
      compareSubLabel: model.name,
      model,
      selection: picked,
      modelPicked: !!picked,
      modelRows,
      ...(picked
        ? {}
        : {
            inheritedEnvironmentModel: {
              modelId: preview.host.modelId,
              modelSelection: preview.host.modelSelection,
            },
          }),
      executionConfig: {
        systemPrompt: config.systemPrompt,
        temperature: config.temperature,
        requireToolApproval: config.requireToolApproval,
      },
      hostSnapshot: snapshotFromHostConfig(config),
      hostConfig: config,
    },
  };
}
