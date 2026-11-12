import {
  validateModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import type { HostDetail, HostListItem } from "@/hooks/useClients";
import type { HostSlot } from "@/hooks/use-playground-host-slots";
import type { ModelDefinition } from "@/shared/types";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { findModelForStoredChoice } from "@/components/chat-v2/shared/model-selection";
import { clientDisplayName } from "@/lib/client-display-name";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import { snapshotFromHostConfig, type HostSnapshot } from "@/lib/host-snapshot";
import { harnessPickerModels } from "@/lib/harness-model-locks";
import { resolveCompareSelectionRow } from "@/lib/compare-cards";
import { paneTargetKey } from "@/lib/compare-panes";
import {
  effectiveHarnessId,
} from "@/shared/harness-descriptors";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";

const INVALID_CHOICE_REASON =
  "The saved model choice is invalid. Edit this client in Connect.";
const UNAVAILABLE_SAVED_REASON =
  "The saved model or connection is unavailable. Edit this client in Connect.";
const UNAVAILABLE_PICK_REASON =
  "This pane's model is unavailable. Choose another in pane settings.";

export interface PlaygroundClientColumn {
  /** The pane's id: keys its card, transcript, readiness and delivery. */
  compareId: string;
  /** The client the column runs. Two panes can run one client. */
  hostId: string;
  /** What the pane runs, as a key: a change of target is a new card. */
  targetKey: string;
  /** Set when the pane runs a named environment on `hostId`. */
  environmentId?: string;
  /**
   * The environment's own model, shown without sending it: an environment
   * pane with no pick inherits it on the server.
   */
  inheritedEnvironmentModel?: {
    modelId: string | null;
    modelSelection?: RequestedModelSelection | null;
  };
  compareLabel: string;
  compareKind: "host";
  compareSubLabel: string;
  model: ModelDefinition;
  /** What the pane sends: its picked model, else the client's saved choice. */
  selection: RequestedModelSelection | undefined;
  /** Someone picked this pane's model, so its turns send that choice. */
  modelPicked: boolean;
  /** The rows this pane's harness runs; empty when its account picks. */
  modelRows: ModelDefinition[];
  executionConfig: ExecutionConfig;
  hostSnapshot: HostSnapshot;
  hostConfig: HostDetail["config"];
}

export type PlaygroundClientResolution =
  | { status: "ready"; column: PlaygroundClientColumn }
  | {
      status: "loading" | "unavailable" | "invalid";
      compareId: string;
      hostId: string;
      targetKey: string;
      environmentId?: string;
      compareLabel: string;
      reason: string;
      /** The saved model, when it resolved but is disabled (e.g. sign-in locked). */
      model?: ModelDefinition;
      /** Set once the client loads, so pane settings can fix the model. */
      hostConfig?: HostDetail["config"];
      modelRows?: ModelDefinition[];
    };

/**
 * Resolve only this client's saved settings; ambient composer state is not an
 * input. `models` is the authorized catalog BEFORE any harness filter: each
 * client reads it through its own harness, so a Codex client never resolves
 * against a Claude Code lead's list.
 */
export function resolvePlaygroundClientColumn({
  paneId,
  hostId,
  slot,
  hosts,
  models,
  orgConfig,
  pickedSelection,
}: {
  /** The pane this column renders. */
  paneId: string;
  /** The model picked in this pane, which wins over the client's saved one. */
  pickedSelection?: RequestedModelSelection;
  hostId: string;
  slot: HostSlot | undefined;
  hosts: readonly HostListItem[];
  models: readonly ModelDefinition[];
  orgConfig?: OrgVisibleConfig;
}): PlaygroundClientResolution {
  const host = slot?.host?.hostId === hostId ? slot.host : null;
  const listed = hosts.find((item) => item.hostId === hostId);
  const identity = {
    compareId: paneId,
    hostId,
    targetKey: paneTargetKey({ kind: "host", hostId }),
    compareLabel: clientDisplayName(
      listed ?? host ?? { name: "Unavailable client" },
    ),
  };
  if (!host)
    return {
      ...identity,
      status: slot?.isLoading ? "loading" : "unavailable",
      reason: slot?.isLoading
        ? "Loading saved configuration…"
        : "This client is unavailable. Remove it to continue.",
    };
  const config = host.config;
  const selection = config.modelSelection;
  if (
    selection &&
    selection.source !== "legacy" &&
    !validateModelSelection(selection).ok
  ) {
    return { ...identity, status: "invalid", reason: INVALID_CHOICE_REASON };
  }
  const harnessId = effectiveHarnessId(config);
  const modelRows = harnessPickerModels([...models], harnessId ? { harnessId } : null, {
        requireOrgKeys: orgRequiresOwnKeys(orgConfig),
      });
  const picked = pickedSelection;
  const model =
    (picked
      ? resolveCompareSelectionRow(picked, modelRows, orgConfig)
      : findModelForStoredChoice(
          { modelId: config.modelId, selection },
          modelRows,
          orgConfig,
          { exactSelection: !!selection && selection.source !== "legacy" },
        ));
  if (!model || model.disabled)
    return {
      ...identity,
      status: "unavailable",
      reason: picked ? UNAVAILABLE_PICK_REASON : UNAVAILABLE_SAVED_REASON,
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
      selection: picked ?? selection,
      modelPicked: !!picked,
      modelRows,
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
