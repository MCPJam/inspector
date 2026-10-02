import { useMemo, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { ClientSelector } from "@/components/chat-v2/chat-input/client-selector";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";
import { HostChipLogo } from "@/components/hosts/host-chip";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { useAvailableModels } from "@/hooks/use-available-models";
import { useModelSelectionsSupported } from "@/hooks/use-project-environment-capability";
import { SelectionEffortControl } from "@/components/effort/selection-effort-control";
import { findModelForStoredChoice } from "@/components/chat-v2/shared/model-selection";
import { useHostHarnessTargets } from "@/hooks/use-host-harness-targets";
import {
  applyHarnessModelLocks,
  type HarnessModelTarget,
} from "@/lib/harness-model-locks";
import type { ModelDefinition } from "@/shared/types";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { ChevronDown, CopyPlus, Plus, Trash2, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  emptyModelSelection,
  modelSelectionForHost,
  modelTargetKey,
  syncExplicitTargets,
  type ModelSelection,
  type ModelTarget,
} from "@/components/environment-composer/environment-stack";
import { modelTarget } from "@/lib/model-target";
import { modelTargetLabel } from "@/lib/environment-label";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import {
  selectionReasoningEffort,
  setEffortForRow,
} from "@/lib/reasoning-effort-selection";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";

import type { HostListItem } from "@/hooks/useClients";
import { clientDisplayName } from "@/lib/client-display-name";

type TargetMatrixHost = Pick<
  HostListItem,
  "hostId" | "name" | "displayName" | "modelId"
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
  const harnessFor = (hostId: string): HarnessModelTarget | null | undefined => {
    const host = hosts.find((candidate) => candidate.hostId === hostId);
    return host?.harness !== undefined
      ? (typeof host.harness === "string" ? { harnessId: host.harness } : host.harness)
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
        harness,
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
  availableModels: catalogModels,
  harness,
  effortEditable = true,
}: {
  /**
   * Show a reasoning-effort chip per explicit model. Off where the surface
   * cannot persist a selection (the case run sheet writes model strings).
   */
  effortEditable?: boolean;
  inModal?: boolean;
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  disabled: boolean;
  testId: string;
  defaultModelId?: string;
  availableModels: ModelDefinition[];
  /**
   * The client's harness (`null`/absent = emulated or not known). Models it
   * cannot run for an eval — unsupported, or not verified on its runtime
   * version — render disabled with the reason, the same verdict the server's
   * eval admission reaches.
   */
  harness?: HarnessModelTarget | null;
}) {
  const availableModels = useMemo(
    () => applyHarnessModelLocks(catalogModels, [harness], "eval"),
    [catalogModels, harness],
  );
  const selectionsSupported = useModelSelectionsSupported();
  const resolveModel = (id: string): ModelDefinition =>
    availableModels.find((model) => String(model.id) === id) ?? {
      id,
      name: compactModelLabel(id),
      provider: "unknown",
    };
  const targets = value.explicitTargets;
  const choices = [
    ...(value.includeClientDefaults
      ? [
          {
            key: "default",
            model: resolveModel(defaultModelId ?? "Client default"),
            inherited: true,
            target: undefined as ModelTarget | undefined,
          },
        ]
      : []),
    ...targets.map((target) => ({
      key: modelTargetKey(target),
      model: resolveModel(target.modelId),
      inherited: false,
      target: target as ModelTarget | undefined,
    })),
  ];
  const emit = (next: ModelSelection, picked?: ModelDefinition) =>
    onChange(
      syncExplicitTargets(next, {
        models: availableModels,
        ...(picked ? { picked } : {}),
      }),
    );
  // Replace (or, with no model, remove) one choice; the default row becomes
  // an explicit target when a model is picked on it.
  const changeChoice = (
    key: string,
    inherited: boolean,
    model?: ModelDefinition,
  ) => {
    const remaining = targets.filter(
      (target) => inherited || modelTargetKey(target) !== key,
    );
    emit(
      {
        includeClientDefaults: inherited ? false : value.includeClientDefaults,
        explicitTargets: model
          ? [...remaining, { modelId: String(model.id) }]
          : remaining,
      },
      model,
    );
  };
  // The catalog row a target was saved from (hosted-first for a legacy pick).
  const rowFor = (target: ModelTarget): ModelDefinition | undefined =>
    findModelForStoredChoice(
      { modelId: target.modelId, selection: target.selection },
      availableModels,
      undefined,
    ) ?? undefined;
  // A new target goes right after the chip it was duplicated from.
  const insertAfter = (key: string, added: ModelTarget) => {
    const index = targets.findIndex((target) => modelTargetKey(target) === key);
    emit({
      ...value,
      explicitTargets: [
        ...targets.slice(0, index + 1),
        added,
        ...targets.slice(index + 1),
      ],
    });
  };
  // An effort a sibling target of the model already runs is not applied
  // (the slider walks past it): two targets never share a comparisonKey, and
  // merging them mid-drag would drop the chip being edited.
  const replaceTarget = (key: string, next: ModelTarget) => {
    const nextKey = modelTargetKey(next);
    if (
      nextKey !== key &&
      targets.some((target) => modelTargetKey(target) === nextKey)
    )
      return;
    emit({
      ...value,
      explicitTargets: targets.map((target) =>
        modelTargetKey(target) === key ? next : target,
      ),
    });
  };
  /**
   * "Add another effort": the chip's model again, as a second target at the
   * next supported level no target of this model uses yet. `null` when the
   * model offers no unused level or its effort cannot be saved here.
   */
  const anotherEffortTarget = (
    target: ModelTarget,
    row: ModelDefinition | undefined,
  ): ModelTarget | null => {
    if (!row || !effortEditable || !selectionsSupported) return null;
    const options = reasoningEffortOptions(
      row,
      reasoningEffortRouteForRow(row),
      harness?.harnessId as Harness | undefined,
    );
    if (options.length === 0) return null;
    const used = new Set<ModelReasoningEffort | undefined>(
      targets
        .filter((other) => other.modelId === target.modelId)
        .map((other) => selectionReasoningEffort(other.selection)),
    );
    const current = selectionReasoningEffort(target.selection);
    const start = current === undefined ? 0 : options.indexOf(current) + 1;
    const next = [...options.slice(start), ...options.slice(0, start)].find(
      (level) => !used.has(level),
    );
    if (next === undefined) return null;
    const write = setEffortForRow({
      row,
      selection: target.selection,
      effort: next,
      purpose: "evalTarget",
    });
    if (!write?.selection) return null;
    const added = modelTarget(write.modelId, write.selection);
    return targets.some(
      (other) => modelTargetKey(other) === modelTargetKey(added),
    )
      ? null
      : added;
  };
  return (
    <div data-testid={testId} className="space-y-1">
      {choices.map(({ key, model, inherited, target }) => (
        <div key={key} className="flex min-w-0 items-start">
          <ModelSelector
            inModal={inModal}
            currentModel={model}
            availableModels={availableModels}
            disabled={disabled}
            analyticsLocation="eval_suite"
            workload="evalTarget"
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
          {!inherited && target && effortEditable ? (
            <SelectionEffortControl
              variant="suffix"
              row={rowFor(target)}
              selection={target.selection}
              purpose="evalTarget"
              selectionsSupported={selectionsSupported}
              harness={harness?.harnessId as Harness | undefined}
              disabled={disabled}
              disabledReason="Editing is disabled."
              hint={`Applies to ${compactModelLabel(model.name)}`}
              onChange={(write) =>
                // Only this target changes; a sibling effort stays.
                replaceTarget(key, modelTarget(write.modelId, write.selection))
              }
            />
          ) : null}
          {!inherited && target
            ? (() => {
                const another = anotherEffortTarget(target, rowFor(target));
                return another ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={`Add another effort of ${model.name}`}
                    title="Add another effort"
                    data-testid={`${testId}-add-effort`}
                    onClick={() => insertAfter(key, another)}
                  >
                    <CopyPlus className="size-3.5" />
                  </Button>
                ) : null;
              })()
            : null}
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
        workload="evalTarget"
        onModelChange={(model) =>
          emit(
            {
              ...value,
              explicitTargets: [...targets, { modelId: String(model.id) }],
            },
            model,
          )
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
