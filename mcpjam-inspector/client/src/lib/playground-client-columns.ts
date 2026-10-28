import { validateModelSelection } from "@mcpjam/sdk/browser";
import type { HostDetail, HostListItem } from "@/hooks/useClients";
import type { HostSlot } from "@/hooks/use-playground-host-slots";
import type { ModelDefinition } from "@/shared/types";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { findModelForStoredChoice } from "@/components/chat-v2/shared/model-selection";
import { clientDisplayName } from "@/lib/client-display-name";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import { snapshotFromHostConfig, type HostSnapshot } from "@/lib/host-snapshot";

export interface PlaygroundClientColumn {
  compareId: string;
  compareLabel: string;
  compareKind: "host";
  compareSubLabel: string;
  model: ModelDefinition;
  executionConfig: ExecutionConfig;
  hostSnapshot: HostSnapshot;
  hostConfig: HostDetail["config"];
}

export type PlaygroundClientResolution =
  | { status: "ready"; column: PlaygroundClientColumn }
  | {
      status: "loading" | "unavailable" | "invalid";
      compareId: string;
      compareLabel: string;
      reason: string;
      /** The saved model, when it resolved but is disabled (e.g. sign-in locked). */
      model?: ModelDefinition;
    };

/** Resolve only this client's saved settings; ambient composer state is not an input. */
export function resolvePlaygroundClientColumn({
  hostId,
  slot,
  hosts,
  models,
  orgConfig,
}: {
  hostId: string;
  slot: HostSlot | undefined;
  hosts: readonly HostListItem[];
  models: readonly ModelDefinition[];
  orgConfig?: OrgVisibleConfig;
}): PlaygroundClientResolution {
  const host = slot?.host?.hostId === hostId ? slot.host : null;
  const listed = hosts.find((item) => item.hostId === hostId);
  const identity = {
    compareId: hostId,
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
    return {
      ...identity,
      status: "invalid",
      reason: "The saved model choice is invalid. Edit this client in Connect.",
    };
  }
  const model = findModelForStoredChoice(
    { modelId: config.modelId, selection },
    models,
    orgConfig,
    { exactSelection: !!selection && selection.source !== "legacy" },
  );
  if (!model || model.disabled)
    return {
      ...identity,
      status: "unavailable",
      reason:
        "The saved model or connection is unavailable. Edit this client in Connect.",
      ...(model ? { model } : {}),
    };
  return {
    status: "ready",
    column: {
      ...identity,
      compareKind: "host",
      compareSubLabel: model.name,
      model,
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
