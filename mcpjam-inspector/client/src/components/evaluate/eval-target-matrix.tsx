import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { ClientSelector } from "@/components/chat-v2/chat-input/client-selector";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";
import { HostChipLogo } from "@/components/hosts/host-chip";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { useAvailableModels } from "@/hooks/use-available-models";
import type { ModelDefinition } from "@/shared/types";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  modelSelectionForHost,
  type ModelSelection,
} from "@/components/environment-composer/environment-stack";

import type { HostListItem } from "@/hooks/useClients";
import { clientDisplayName } from "@/lib/client-display-name";

type TargetMatrixHost = Pick<
  HostListItem,
  "hostId" | "name" | "displayName" | "modelId"
>;

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
  for (const modelId of selection?.explicitModelIds ?? []) {
    labels.push(modelNames.get(modelId) ?? compactModelLabel(modelId));
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
  renderModels?: (hostId: string) => ReactNode;
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
            Where it runs{" "}
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
                  renderModels(row.hostId)
                ) : modelsEditable ? (
                  <EvalModelPicker
                    inModal={inModal}
                    projectId={projectId}
                    value={modelSelectionForHost(
                      {
                        modelSelection: modelSelection ?? {
                          includeClientDefaults: true,
                          explicitModelIds: [],
                        },
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
                    {row.modelLabels.join(" · ")}
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
  onSelect: (hostId: string) => void;
}) {
  const host = hosts.find((host) => host.hostId === currentHostId);
  return (
    <ClientSelector
      inModal={inModal}
      hosts={[...hosts]}
      projectId={null}
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
              logoSrc={resolveHostLogoByName(host?.name ?? label)}
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
}: {
  projectId: string;
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  disabled: boolean;
  inModal?: boolean;
  testId: string;
  defaultModelId?: string;
}) {
  const { availableModels } = useAvailableModels({ projectId });
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
      }}
    />
  );
}

export function EvalModelChoices({
  inModal,
  value,
  onChange,
  disabled,
  testId,
  defaultModelId,
  availableModels,
}: {
  inModal?: boolean;
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  disabled: boolean;
  testId: string;
  defaultModelId?: string;
  availableModels: ModelDefinition[];
}) {
  const resolveModel = (id: string): ModelDefinition =>
    availableModels.find((model) => String(model.id) === id) ?? {
      id,
      name: compactModelLabel(id),
      provider: "unknown",
    };
  const choices = [
    ...(value.includeClientDefaults
      ? [
          {
            key: "default",
            model: resolveModel(defaultModelId ?? "Client default"),
            inherited: true,
          },
        ]
      : []),
    ...value.explicitModelIds.map((id) => ({
      key: id,
      model: resolveModel(id),
      inherited: false,
    })),
  ];
  const changeChoice = (
    key: string,
    inherited: boolean,
    model?: ModelDefinition,
  ) => {
    const remaining = value.explicitModelIds.filter(
      (id) => inherited || id !== key,
    );
    onChange({
      includeClientDefaults: inherited ? false : value.includeClientDefaults,
      explicitModelIds: model
        ? [...new Set([...remaining, String(model.id)])]
        : remaining,
    });
  };
  return (
    <div data-testid={testId} className="space-y-1">
      {choices.map(({ key, model, inherited }) => (
        <div key={key} className="flex min-w-0 items-start">
          <ModelSelector
            inModal={inModal}
            currentModel={model}
            availableModels={availableModels}
            disabled={disabled}
            analyticsLocation="eval_suite"
            onModelChange={(next) => changeChoice(key, inherited, next)}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                className="h-auto min-h-8 min-w-0 flex-1 justify-start gap-2 px-2 text-left font-normal whitespace-normal"
              >
                <ProviderLogo
                  provider={model.provider}
                  customProviderName={model.customProviderName}
                  className="size-4 shrink-0"
                />
                <span className="min-w-0 flex-1 break-words">
                  {compactModelLabel(model.name)}
                </span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </Button>
            }
          />
          {choices.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${model.name} model`}
              title={`Remove ${model.name} model`}
              onClick={() => changeChoice(key, inherited)}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
      <ModelSelector
        inModal={inModal}
        currentModel={{
          id: "__add_model__",
          name: "Add model",
          provider: "unknown",
        }}
        availableModels={availableModels.filter(
          (model) =>
            !choices.some(
              (choice) => String(choice.model.id) === String(model.id),
            ),
        )}
        disabled={disabled}
        analyticsLocation="eval_suite"
        onModelChange={(model) =>
          onChange({
            ...value,
            explicitModelIds: [...value.explicitModelIds, String(model.id)],
          })
        }
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-8 gap-2 px-2 text-xs font-normal text-muted-foreground"
          >
            <Plus className="size-3.5" />
            Add model
          </Button>
        }
      />
    </div>
  );
}
