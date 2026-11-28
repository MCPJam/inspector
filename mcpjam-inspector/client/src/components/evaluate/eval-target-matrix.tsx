import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { ClientSelector } from "@/components/chat-v2/chat-input/client-selector";
import { HostChipLogo } from "@/components/hosts/host-chip";
import { resolveHostLogo } from "@/lib/host-logo";
import { useAvailableModels } from "@/hooks/use-available-models";
import { useHostHarnessTargets } from "@/hooks/use-host-harness-targets";
import {
  harnessTargetOfHost,
  type HarnessModelTarget,
} from "@/lib/harness-model-locks";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  emptyModelSelection,
  modelSelectionForHost,
  type ModelSelection,
} from "@/components/environment-composer/environment-stack";
import { modelTargetLabel } from "@/lib/environment-label";

import type { HostListItem } from "@/hooks/useClients";
import { clientDisplayName } from "@/lib/client-display-name";
import { EvalModelChoices } from "./eval-model-choices";

type TargetMatrixHost = Pick<
  HostListItem,
  | "hostId"
  | "name"
  | "displayName"
  | "modelId"
  | "hostStyle"
  | "agentLoop"
  | "runtime"
> & {
  /**
   * The harness this client runs (`null` = emulated), with its runtime version
   * when known. When the caller does not supply it the matrix reads it from
   * the host's config, so the model pickers can disable what it cannot run.
   */
  harness?: HarnessModelTarget | HostListItem["harness"] | null;
};

type TargetMatrixModel = {
  id: string | number;
  name: string;
};

type TargetMatrixRow = {
  hostId: string;
  clientName: string;
  modelLabels: string[];
};

export function buildEvalTargetMatrixRows({
  hostIds,
  hosts,
  modelSelection,
  modelSelectionsByHost,
  availableModels,
}: {
  hostIds: readonly string[];
  hosts: readonly TargetMatrixHost[];
  modelSelection: ModelSelection | undefined;
  modelSelectionsByHost?: Record<string, ModelSelection>;
  availableModels: readonly TargetMatrixModel[];
}): TargetMatrixRow[] {
  const modelNames = new Map(
    availableModels.map((model) => [
      String(model.id),
      compactModelLabel(model.name),
    ]),
  );

  return hostIds.map((hostId) => {
    const host = hosts.find((candidate) => candidate.hostId === hostId);
    const clientName = host ? clientDisplayName(host) : hostId.slice(0, 8);
    const selection = modelSelectionsByHost?.[hostId] ?? modelSelection;
    const modelLabels = modelLabelsForSelection(selection, host, modelNames);

    return { hostId, clientName, modelLabels };
  });
}

function modelLabelsForSelection(
  selection: ModelSelection | undefined,
  host: TargetMatrixHost | undefined,
  modelNames: ReadonlyMap<string, string>,
): string[] {
  const labels: string[] = [];
  if (selection?.includeClientDefaults !== false) {
    const defaultModel = host?.modelId
      ? (modelNames.get(host.modelId) ?? compactModelLabel(host.modelId))
      : "";
    labels.push(
      defaultModel ? `Client default · ${defaultModel}` : "Client default",
    );
  }
  // Model name plus only what differs among its siblings: "Sonnet 4.5 · High"
  // beside "Sonnet 4.5 · Low"; a lone model has no suffix.
  const targets = selection?.explicitTargets ?? [];
  for (const target of targets) {
    labels.push(
      modelTargetLabel(
        target,
        targets,
        (modelId) => modelNames.get(modelId) ?? compactModelLabel(modelId),
      ),
    );
  }
  return labels;
}

/**
 * A readable projection of the client × model fan-out. It deliberately mirrors
 * the resolver's host-major cells, so a person can see the execution plan before
 * the suite turns those selections into attached environments.
 */
export function EvalTargetMatrix({
  hostIds,
  hosts,
  modelSelection,
  modelSelectionsByHost,
  availableModels,
  maxTargets,
  projectId,
  disabled = false,
  inModal = false,
  hideHeading = false,
  modelsEditable,
  onHostsChange,
  onModelSelectionChange,
  onRemoveClient,
  singleClient = false,
  renderModels,
}: {
  hostIds: readonly string[];
  hosts: readonly TargetMatrixHost[];
  modelSelection: ModelSelection | undefined;
  modelSelectionsByHost?: Record<string, ModelSelection>;
  availableModels: readonly TargetMatrixModel[];
  singleClient?: boolean;
  /** Custom models cell. `harness` is the row client's harness target, for
   *  a picker that must disable the models it cannot run. */
  renderModels?: (
    hostId: string,
    harness: HarnessModelTarget | null | undefined,
  ) => ReactNode;
  maxTargets: number;
  projectId: string;
  disabled?: boolean;
  inModal?: boolean;
  hideHeading?: boolean;
  modelsEditable: boolean;
  onHostsChange: (hostIds: string[]) => void;
  onModelSelectionChange: (hostId: string, selection: ModelSelection) => void;
  onRemoveClient: (hostId: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const readHarnessByHost = useHostHarnessTargets(hostIds);
  const harnessFor = (
    hostId: string,
  ): HarnessModelTarget | null | undefined => {
    const host = hosts.find((candidate) => candidate.hostId === hostId);
    const harness = host?.harness;
    if (harness && typeof harness === "object") return harness;
    // A list row carries the client's runtime; a paired client (Claude,
    // ChatGPT) has `harness: null` and its runtime in `agentLoop`.
    return host &&
      (host.runtime !== undefined ||
        harness !== undefined ||
        host.agentLoop !== undefined)
      ? harnessTargetOfHost({
          runtime: host.runtime,
          harness: harness ?? null,
          agentLoop: host.agentLoop ?? null,
        })
      : readHarnessByHost[hostId];
  };
  const rows = buildEvalTargetMatrixRows({
    hostIds,
    hosts,
    modelSelection,
    modelSelectionsByHost,
    availableModels,
  });
  const targetCount = rows.reduce(
    (total, row) => total + row.modelLabels.length,
    0,
  );

  return (
    <section
      aria-labelledby={hideHeading ? undefined : "where-it-runs-heading"}
      aria-label={hideHeading ? "Clients and models" : undefined}
      data-testid="create-suite-target-matrix"
      className="space-y-3"
    >
      {!hideHeading && (
        <div className="space-y-1">
          <h2 id="where-it-runs-heading" className="text-sm font-medium">
            Clients and models{" "}
            <span className="ml-1 text-destructive" aria-hidden="true">
              *
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Choose a client and the models to evaluate it with.
          </p>
        </div>
      )}
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="w-[40%] px-2 py-2 font-medium">
              Client
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Models
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <motion.tr
              key={row.hostId}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.16 }}
              className="border-b border-border/60"
            >
              <td className="py-2 pr-6 align-top">
                <div className="flex min-w-0 items-start">
                  <div className="min-w-0 flex-1">
                    <ClientPicker
                      inModal={inModal}
                      projectId={projectId}
                      hosts={hosts.filter(
                        (host) =>
                          host.hostId === row.hostId ||
                          !hostIds.includes(host.hostId),
                      )}
                      label={row.clientName}
                      currentHostId={row.hostId}
                      disabled={disabled}
                      onSelect={(hostId) =>
                        onHostsChange(
                          hostIds.map((id) =>
                            id === row.hostId ? hostId : id,
                          ),
                        )
                      }
                    />
                  </div>
                  {!singleClient && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => onRemoveClient(row.hostId)}
                      disabled={disabled}
                      aria-label={`Remove ${row.clientName}`}
                      title={`Remove ${row.clientName} and its models`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              </td>
              <td className="py-2 pr-2 align-top">
                {renderModels ? (
                  renderModels(row.hostId, harnessFor(row.hostId))
                ) : modelsEditable ? (
                  <EvalModelPicker
                    harness={harnessFor(row.hostId)}
                    inModal={inModal}
                    projectId={projectId}
                    value={modelSelectionForHost(
                      {
                        modelSelection: modelSelection ?? emptyModelSelection(),
                        modelSelectionsByHost,
                      },
                      row.hostId,
                    )}
                    onChange={(selection) =>
                      onModelSelectionChange(row.hostId, selection)
                    }
                    disabled={disabled}
                    testId={`create-suite-model-${row.hostId}`}
                    defaultModelId={
                      hosts.find((host) => host.hostId === row.hostId)?.modelId
                    }
                  />
                ) : (
                  <span className="block px-2 py-2 text-xs">
                    {row.modelLabels.join(", ")}
                  </span>
                )}
              </td>
            </motion.tr>
          ))}
        </tbody>
        {!singleClient && (
          <tfoot>
            <tr className="border-b border-border">
              <td colSpan={2} className="py-2">
                <ClientPicker
                  inModal={inModal}
                  projectId={projectId}
                  hosts={hosts.filter((host) => !hostIds.includes(host.hostId))}
                  label="Add client"
                  add
                  disabled={disabled || hostIds.length >= maxTargets}
                  onSelect={(hostId) => onHostsChange([...hostIds, hostId])}
                />
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {targetCount > maxTargets ? (
        <p role="alert" className="text-xs text-destructive">
          Choose up to {maxTargets} client/model combinations.
        </p>
      ) : null}
    </section>
  );
}

function ClientPicker({
  inModal,
  projectId,
  hosts,
  label,
  currentHostId = null,
  add = false,
  disabled,
  onSelect,
}: {
  hosts: readonly TargetMatrixHost[];
  label: string;
  currentHostId?: string | null;
  add?: boolean;
  disabled: boolean;
  inModal?: boolean;
  projectId: string;
  onSelect: (hostId: string) => void;
}) {
  const host = hosts.find((host) => host.hostId === currentHostId);
  return (
    <ClientSelector
      inModal={inModal}
      hosts={[...hosts]}
      projectId={projectId || null}
      cloudProjectId={null}
      currentHostId={currentHostId}
      selectedHostIds={currentHostId ? [currentHostId] : []}
      onHostChange={onSelect}
      onSelectedHostIdsChange={() => {}}
      onMultiHostEnabledChange={() => {}}
      onPromoteLead={() => {}}
      disabled={disabled}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          data-testid={add ? "create-suite-add-client" : undefined}
          className="h-auto min-h-8 w-full justify-start gap-2 px-2 text-left font-normal whitespace-normal"
        >
          {add ? (
            <Plus className="size-3.5 shrink-0" />
          ) : (
            <HostChipLogo
              logoSrc={resolveHostLogo(host ?? { name: label })}
              name={label}
              size="sm"
            />
          )}
          <span className="min-w-0 break-words">{label}</span>
          {!add ? (
            <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
        </Button>
      }
    />
  );
}

function EvalModelPicker({
  inModal,
  projectId,
  value,
  onChange,
  disabled,
  testId,
  defaultModelId,
  harness,
}: {
  harness?: HarnessModelTarget | null;
  projectId: string;
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  disabled: boolean;
  inModal?: boolean;
  testId: string;
  defaultModelId?: string;
}) {
  const {
    availableModels,
    requireOrgKeys,
    onManageOrgProviders,
    onAddProvider,
  } = useAvailableModels({ projectId, harnessTargets: [harness] });
  return (
    <EvalModelChoices
      {...{
        inModal,
        value,
        onChange,
        disabled,
        testId,
        defaultModelId,
        availableModels,
        harnessTargets: [harness],
        requireOrgKeys,
        onManageOrgProviders,
        onAddProvider,
      }}
    />
  );
}
