import { useState } from "react";
import { useConvex, useConvexAuth, useQuery } from "convex/react";
import { useHostList, type HostListItem } from "@/hooks/useClients";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  useEnsureAdhocEnvironments,
  useProjectEnvironments,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { useEnvironmentCapabilities } from "@/hooks/use-environment-capabilities";
import { ServerPicker } from "@/components/hosts/server-picker";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { compactModelIdTail } from "@/lib/environment-label";
import {
  emptyModelSelection,
  type ModelSelection,
} from "@/components/environment-composer/environment-stack";
import {
  dedupeModelTargets,
  environmentModelTarget,
  modelTarget,
  type ModelTarget,
} from "@/lib/model-target";
import {
  isLegacySelection,
  type ModelSelection as SavedModelSelection,
} from "@mcpjam/sdk/browser";
import { environmentsForModelCell } from "@/lib/reasoning-effort-selection";
import { MAX_SUITE_ENVIRONMENTS } from "@/components/project-environments/environment-picker";
import { isModelFree, promptTurnsToSteps } from "@/shared/steps";
import type { EvalCase, EvalServerAttachment, EvalSuite } from "../evals/types";
import { EvalTargetMatrix } from "./eval-target-matrix";
import {
  chooseTemplate,
  composeAdhocStack,
  lacksServerSource,
  legacySuiteComposition,
  unpreservableReason,
  type AdhocStack,
} from "./environment-template";
import {
  SuiteRunReviewContent,
  type SuiteRunReviewProps,
} from "./suite-run-review";

type PlannedCombination = {
  environmentId?: string;
  stack: AdhocStack;
  /**
   * With backend derivation: build this cell server-side from the stored
   * source (every pin kept) instead of composing `stack`.
   */
  derive?: {
    sourceEnvironmentId: string;
    expectedRevision: number;
    overrides: {
      hostId: string;
      modelId: string | null;
      /** The picked model's saved selection (carries its effort). */
      modelSelection?: SavedModelSelection;
    };
  };
  /** Why this cell cannot start; the dialog shows the first one. */
  blocked?: string;
  /** No server group and no plugin pin: the run would connect no servers. */
  missingGroup?: boolean;
};

type Environments = NonNullable<SuiteRunReviewProps["environments"]>;
export function seedRunMatrix(
  suite: SuiteRunReviewProps["suite"],
  environments: Environments,
) {
  const selections: Record<string, ModelSelection> = {};
  for (const id of suite.environmentIds ?? []) {
    const environment = environments.find((item) => item.environmentId === id);
    if (!environment) continue;
    const selection = (selections[environment.hostId] ??= {
      includeClientDefaults: false,
      explicitTargets: [],
    });
    // One cell per comparisonKey: the environment's own saved selection (its
    // effort) is what the run reuses, so two efforts of one model seed two
    // cells instead of collapsing onto the first.
    const target = environmentModelTarget(environment);
    if (target)
      selection.explicitTargets = dedupeModelTargets([
        ...selection.explicitTargets,
        target,
      ]);
    else selection.includeClientDefaults = true;
  }
  if (!suite.environmentIds?.length) {
    for (const host of suite.hostAttachments ?? [])
      selections[host.namedHostId] = emptyModelSelection();
  }
  return selections;
}

/** The SDK reporter's stand-in model when a CI run reported none. */
const NO_REPORTED_MODEL = "n/a";

/**
 * The models a suite WITHOUT environments runs: each case's own models, plus
 * the suite default for a prompt case that lists none — the backend's
 * legacy-suite converter follows the same rule. A model-free case runs no
 * model, and the SDK reporter's `n/a` names none. Only models this project
 * can run are kept, so a model a CI used that MCPJam does not offer is not
 * pre-picked. Nothing left ⇒ the client's own model.
 */
export function suiteCaseModels(
  suite: Pick<EvalSuite, "defaultConfig">,
  cases: readonly Pick<EvalCase, "models" | "steps" | "promptTurns">[],
  runnable: ReadonlySet<string>,
): ModelSelection {
  const targets: ModelTarget[] = [];
  let promptCaseWithoutModel = false;
  for (const testCase of cases) {
    const steps = Array.isArray(testCase.steps)
      ? testCase.steps
      : promptTurnsToSteps(
          Array.isArray(testCase.promptTurns) ? testCase.promptTurns : [],
        );
    if (isModelFree(steps)) continue;
    if (!testCase.models?.length) promptCaseWithoutModel = true;
    for (const entry of testCase.models ?? []) {
      const modelId = (entry.selection?.modelId ?? entry.model)?.trim();
      if (!modelId || modelId.toLowerCase() === NO_REPORTED_MODEL) continue;
      // An old-format selection is no selection a cell can carry; its id is.
      targets.push(
        modelTarget(
          modelId,
          entry.selection && !isLegacySelection(entry.selection)
            ? entry.selection
            : undefined,
        ),
      );
    }
  }
  if (promptCaseWithoutModel && suite.defaultConfig?.modelId)
    targets.push({ modelId: suite.defaultConfig.modelId });
  const explicitTargets = dedupeModelTargets(
    targets.filter((target) => runnable.has(target.modelId)),
  );
  return explicitTargets.length
    ? { includeClientDefaults: false, explicitTargets }
    : emptyModelSelection();
}

/**
 * The clients a suite WITHOUT environments starts from: the ones it attaches
 * that still exist, else the one its own launch would attach (the backend's
 * `ensureProjectDefaultHost`): a user-owned client on the project's default
 * config, else the first user-owned client.
 */
export function suiteRunClients(
  suite: Pick<EvalSuite, "hostAttachments">,
  hosts: readonly Pick<HostListItem, "hostId" | "hostConfigId" | "ownerScope">[],
  projectDefaultHostConfigId: string | null | undefined,
): string[] {
  const attached = (suite.hostAttachments ?? [])
    .map((host) => host.namedHostId)
    .filter((id) => hosts.some((host) => host.hostId === id));
  if (attached.length) return [...new Set(attached)];
  const userHosts = hosts.filter((host) => !host.ownerScope);
  const fallback =
    userHosts.find(
      (host) => host.hostConfigId === projectDefaultHostConfigId,
    ) ?? userHosts[0];
  return fallback ? [fallback.hostId] : [];
}

/** How the backend names a group member whose server is gone. */
const DELETED_SERVER = "[deleted server]";

/**
 * The server group a suite WITHOUT environments runs on: its own pinned
 * group, which its runs use for every attached client. Offered only while it
 * is a group of this project with a live server; otherwise the person picks.
 * The SDK reporter's server names (`environment.servers`) are never a source.
 */
export function seedSuiteRunGroup(
  suite: Pick<EvalSuite, "serverAttachmentId">,
  groups: readonly Pick<EvalServerAttachment, "_id" | "resolvedServerNames">[],
): string | null {
  const group = suite.serverAttachmentId
    ? groups.find((row) => row._id === suite.serverAttachmentId)
    : undefined;
  return group?.resolvedServerNames.some((name) => name !== DELETED_SERVER)
    ? group._id
    : null;
}

/** Each client of a suite WITHOUT environments, on the cases' models. */
export function seedSuiteRunMatrix(
  suite: Pick<EvalSuite, "defaultConfig" | "hostAttachments">,
  cases: readonly Pick<EvalCase, "models" | "steps" | "promptTurns">[],
  hosts: readonly Pick<HostListItem, "hostId" | "hostConfigId" | "ownerScope">[],
  projectDefaultHostConfigId: string | null | undefined,
  runnable: ReadonlySet<string>,
): Record<string, ModelSelection> {
  const models = suiteCaseModels(suite, cases, runnable);
  return Object.fromEntries(
    suiteRunClients(suite, hosts, projectDefaultHostConfigId).map((id) => [
      id,
      { ...models, explicitTargets: [...models.explicitTargets] },
    ]),
  );
}

/** The backend finds, creates or derives at most this many environments per call. */
const ENVIRONMENT_BATCH = 10;

/** `run` over `items` ten at a time, results in input order. */
export async function inEnvironmentBatches<T, R>(
  items: readonly T[],
  run: (batch: T[]) => Promise<readonly R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += ENVIRONMENT_BATCH)
    out.push(...(await run(items.slice(start, start + ENVIRONMENT_BATCH))));
  return out;
}

/**
 * Reuse exact saved environments; only new combinations need resolving.
 *
 * A new combination copies the ONE setup its candidates share — the client's
 * own environments, or every environment for a client the suite does not
 * attach. Never `attached[0]` when they disagree, and never the suite's legacy
 * `serverAttachmentId`: an environment suite does not read it, so an
 * environment built from it can run with no servers at all. A cell that cannot
 * be derived faithfully is BLOCKED (with the reason) instead of guessed.
 *
 * A suite WITHOUT environments has no candidate to copy. Its cells run on
 * `group`, the server group picked in the dialog (pre-filled there, in plain
 * sight, from the suite's own group), with the suite's own skills and image.
 */
export function planRunMatrix(
  suite: SuiteRunReviewProps["suite"],
  environments: Environments,
  selections: Record<string, ModelSelection>,
  options: {
    /**
     * The backend derives one-run cells from the stored source
     * (`environmentDerivation`), so a pinned setup no longer blocks them.
     */
    lossless?: boolean;
    /**
     * The deployment stores model selections: new cells carry the picked
     * model's selection (and so its effort). Off ⇒ legacy ids only.
     */
    modelSelections?: boolean;
    /** A suite without environments: the server group its cells run on. */
    group?: string | null;
  } = {},
): PlannedCombination[] {
  const attached = (suite.environmentIds ?? []).map((id) => {
    const environment = environments.find((item) => item.environmentId === id);
    if (!environment)
      throw new Error(
        "The suite's clients are still loading. Try again shortly.",
      );
    return environment;
  });
  return Object.entries(selections).flatMap(([hostId, selection]) => {
    const targets = [
      ...(selection.includeClientDefaults ? [undefined] : []),
      // Without stored selections a target is its bare id: two efforts of
      // one model would be one cell, so they are one target.
      ...dedupeModelTargets(
        options.modelSelections
          ? selection.explicitTargets
          : selection.explicitTargets.map(({ modelId }) => ({ modelId })),
      ),
    ];
    return targets.flatMap<PlannedCombination>((target) => {
      const modelId = target?.modelId;
      const picked = target?.selection;
      const pickedSelection = options.modelSelections ? picked : undefined;
      // An environment is reused only when it runs this cell's target (same
      // comparisonKey); each effort of a model is its own cell.
      const existing = environmentsForModelCell(attached, {
        hostId,
        modelId,
        picked,
        efforts: options.modelSelections === true,
      });
      if (existing.length)
        return existing.map((environment) => ({
          environmentId: environment.environmentId,
          stack: { hostId, modelId },
          missingGroup: lacksServerSource(environment),
        }));
      const onHost = attached.filter(
        (environment) => environment.hostId === hostId,
      );
      const bare = {
        hostId,
        ...(modelId ? { modelId } : {}),
        ...(pickedSelection ? { modelSelection: pickedSelection } : {}),
      };
      const choice = chooseTemplate(
        (onHost.length ? onHost : attached) as ProjectEnvironmentView[],
      );
      if (choice.kind === "ambiguous")
        return [
          {
            stack: bare,
            blocked: onHost.length
              ? "This client's setups differ, so a new model has no single setup to copy. Add it in suite settings first."
              : "This suite's clients don't share one setup, so a new client has no single setup to copy. Add it in suite settings first.",
          },
        ];
      // Only a suite without environments has no candidate at all.
      if (choice.kind === "none")
        return [
          options.group
            ? {
                stack: composeAdhocStack(
                  {
                    ...legacySuiteComposition(suite),
                    serverAttachmentId: options.group,
                  },
                  bare,
                ),
              }
            : { stack: bare, missingGroup: true },
        ];
      if (options.lossless)
        return [
          {
            stack: bare,
            derive: {
              sourceEnvironmentId: choice.source.environmentId,
              expectedRevision: choice.source.revision,
              overrides: {
                hostId,
                modelId: modelId ?? null,
                ...(pickedSelection ? { modelSelection: pickedSelection } : {}),
              },
            },
            missingGroup: lacksServerSource(choice.composition),
          },
        ];
      const reason = unpreservableReason(choice.composition);
      if (reason)
        return [
          {
            stack: bare,
            blocked: `This setup ${reason}, which a one-run change can't copy. Add the combination in suite settings instead.`,
          },
        ];
      return [
        {
          stack: composeAdhocStack(choice.composition, bare),
          missingGroup: lacksServerSource(choice.composition),
        },
      ];
    });
  });
}

export function ConfiguredSuiteRunReview(
  props: SuiteRunReviewProps & { projectId: string },
) {
  const { suite, cases, projectId, environments = [] } = props;
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { availableModels, modelSelectionsSupported } = useAvailableModels({
    projectId,
  });
  const { capable, pending } = useEvalComposeCapable(projectId);
  // Until the probe answers, plan as an older backend would: a cell the
  // browser can't copy stays blocked rather than being composed lossily.
  const capabilities = useEnvironmentCapabilities(projectId);
  const lossless = capabilities?.environmentDerivation === true;
  const ensure = useEnsureAdhocEnvironments();
  const convex = useConvex();
  const [draft, setDraft] = useState<Record<string, ModelSelection> | null>(
    null,
  );
  // A suite WITHOUT environments (made before "Where it runs", or reported by
  // an SDK) runs one-run cells composed here: a server group, clients and
  // models. The suite itself is never changed.
  const withoutSetups = !suite.environmentIds?.length;
  const sdkSuite = withoutSetups && suite.source === "sdk";
  const { serverAttachments: groups, isLoading: groupsLoading } =
    useProjectServerAttachments({
      isAuthenticated,
      projectId: withoutSetups ? projectId : null,
    });
  const defaultClientQueried =
    withoutSetups &&
    !suite.hostAttachments?.length &&
    isAuthenticated &&
    shouldQueryProjectId(projectId);
  const projectDefault = useQuery(
    "hostConfigsV2:getProjectDefault" as any,
    defaultClientQueried ? ({ projectId } as any) : "skip",
  ) as { id?: string } | null | undefined;
  // An SDK suite may also run in a saved project environment, as before.
  const projectEnvironments = useProjectEnvironments(
    sdkSuite ? projectId : null,
  );
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  const [runSaved, setRunSaved] = useState(false);
  const [savedId, setSavedId] = useState<string>();
  const selections =
    draft ??
    (withoutSetups
      ? seedSuiteRunMatrix(
          suite,
          cases,
          hosts,
          projectDefault?.id,
          new Set(availableModels.map((model) => String(model.id))),
        )
      : seedRunMatrix(suite, environments));
  const group = withoutSetups
    ? (pickedGroup ?? seedSuiteRunGroup(suite, groups))
    : null;
  const unresolved = suite.environmentIds?.some(
    (id) =>
      !environments.some((environment) => environment.environmentId === id),
  );
  const plan = unresolved
    ? []
    : planRunMatrix(suite, environments, selections, {
        lossless,
        modelSelections: modelSelectionsSupported,
        group,
      });
  const blockedCell = plan.find((item) => item.blocked)?.blocked ?? null;
  // Start is refused for any cell that would connect no servers: a new cell
  // copying a group-less setup, or an attached environment that has none.
  const missingGroup = plan.some((item) => item.missingGroup);
  // A "client default" cell on a client with no model has nothing to run; the
  // backend rejects it, so block Start here instead.
  const missingModel = plan.some(
    ({ stack }) =>
      stack.modelId === undefined &&
      !hosts.find((host) => host.hostId === stack.hostId)?.modelId?.trim(),
  );
  const launchable = (projectEnvironments ?? []).filter(
    (environment) => !environment.archivedAt && !lacksServerSource(environment),
  );
  const runInSaved = sdkSuite && runSaved && launchable.length > 0;
  const savedEnvironment = runInSaved
    ? launchable.find((environment) => environment.environmentId === savedId)
    : undefined;
  // Older deployments retain their launch path until they support model overrides.
  if (!capable && !pending) return <SuiteRunReviewContent {...props} />;
  // A cell the suite does not attach needs a backend that launches one, and a
  // suite of this project; otherwise the suite keeps its own launch.
  if (
    withoutSetups &&
    (capabilities === null ||
      (capabilities !== undefined &&
        capabilities.ephemeralEnvironmentLaunch !== true) ||
      suite.projectId !== projectId)
  )
    return <SuiteRunReviewContent {...props} />;
  const loadingSetups =
    withoutSetups &&
    (capabilities === undefined ||
      groupsLoading ||
      (defaultClientQueried && projectDefault === undefined));
  const blocked =
    props.disabledReason ??
    (isLoading || pending || unresolved || loadingSetups
      ? "Loading clients and models…"
      : runInSaved
        ? savedEnvironment
          ? null
          : "Pick the environment to run this suite in."
        : plan.length > MAX_SUITE_ENVIRONMENTS
          ? `Choose up to ${MAX_SUITE_ENVIRONMENTS} client/model combinations.`
          : !plan.length || missingModel
            ? "Choose at least one client and model."
            : blockedCell
              ? blockedCell
              : missingGroup
                ? withoutSetups
                  ? "Pick a server group to run this suite."
                  : "A selected client has no server group, so its run would connect no servers. Pick a server group in suite settings."
                : null);
  const startMatrix: SuiteRunReviewProps["onStart"] = async (_, options) => {
    const missing = plan.filter((item) => !item.environmentId);
    if (missing.length) {
      const capabilities = (await convex.query(
        "projectEnvironments:getCapabilities" as any,
        { projectId },
      )) as { ephemeralEnvironmentLaunch?: boolean };
      if (!capabilities?.ephemeralEnvironmentLaunch) {
        throw new Error(
          "This deployment does not support one-run client/model changes yet. Save these pairings in suite settings or use the configured pairings.",
        );
      }
    }
    // One-run cells never touch the suite: derived ones are built from
    // their stored source, composed ones from their stack.
    const derived = missing.filter((item) => item.derive);
    const composed = missing.filter((item) => !item.derive);
    const derivedRows = await inEnvironmentBatches(
      derived,
      (batch) =>
        convex.mutation("projectEnvironments:deriveEnvironments" as any, {
          projectId,
          derivations: batch.map((item) => item.derive),
        }) as Promise<Array<{ environment?: { environmentId?: string } }>>,
    );
    const resolved = await inEnvironmentBatches(composed, (batch) =>
      ensure({ projectId, stacks: batch.map((item) => item.stack) }),
    );
    let nextDerived = 0;
    let nextComposed = 0;
    const environmentIds = plan.map((item) =>
      item.environmentId
        ? item.environmentId
        : item.derive
          ? derivedRows[nextDerived++]?.environment?.environmentId
          : resolved[nextComposed++]?.environment.environmentId,
    );
    if (environmentIds.some((id) => !id))
      throw new Error(
        "Could not resolve the selected clients and models. Try again.",
      );
    await props.onStart(
      {
        ...suite,
        environmentIds: environmentIds as string[],
        hostAttachments: Object.keys(selections).map((namedHostId) => ({
          namedHostId,
          enabledOptionalServerIds: [],
          hostName: props.hostNamesById.get(namedHostId) ?? null,
          resolvedServerNames: [],
        })),
      },
      {
        ...options,
        ...(missing.length ? { ephemeralEnvironment: true } : {}),
      },
    );
  };
  const startSaved: SuiteRunReviewProps["onStart"] = (run, options) =>
    props.onStart(
      {
        ...run,
        environmentIds: [savedEnvironment!.environmentId],
        hostAttachments: [],
      },
      { ...options, ephemeralEnvironment: true },
    );
  return (
    <SuiteRunReviewContent
      {...props}
      disabledReason={blocked}
      matrix={{
        count: runInSaved ? (savedEnvironment ? 1 : 0) : plan.length,
        render: (starting) => (
          <div className="space-y-5">
            {sdkSuite ? (
              <SdkRunSource
                offerSaved={launchable.length > 0}
                saved={runInSaved}
                onChange={setRunSaved}
                disabled={starting}
              />
            ) : null}
            {runInSaved ? (
              <SavedEnvironmentList
                environments={launchable}
                value={savedId}
                onChange={setSavedId}
                hostNamesById={props.hostNamesById}
                disabled={starting}
              />
            ) : (
              <>
                {withoutSetups ? (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">Servers</p>
                    <ServerPicker
                      projectId={projectId}
                      value={group}
                      onChange={(id) => setPickedGroup(id)}
                      onClearSelection={() => setPickedGroup(null)}
                      offerClear={false}
                      variant="field"
                      inModal
                      disabled={starting || loadingSetups}
                      emptyTriggerLabel="Pick a server group"
                      triggerTestId="suite-run-server-group"
                    />
                  </div>
                ) : null}
                <EvalTargetMatrix
                  hostIds={Object.keys(selections)}
                  hosts={hosts}
                  modelSelection={undefined}
                  modelSelectionsByHost={selections}
                  availableModels={availableModels}
                  maxTargets={MAX_SUITE_ENVIRONMENTS}
                  projectId={projectId}
                  disabled={
                    starting || pending || Boolean(unresolved) || loadingSetups
                  }
                  modelsEditable
                  inModal
                  onHostsChange={(ids) =>
                    setDraft(
                      Object.fromEntries(
                        ids.map((id) => [
                          id,
                          selections[id] ?? emptyModelSelection(),
                        ]),
                      ),
                    )
                  }
                  onModelSelectionChange={(hostId, selection) =>
                    setDraft({ ...selections, [hostId]: selection })
                  }
                  onRemoveClient={(hostId) =>
                    setDraft(
                      Object.fromEntries(
                        Object.entries(selections).filter(
                          ([id]) => id !== hostId,
                        ),
                      ),
                    )
                  }
                />
              </>
            )}
          </div>
        ),
      }}
      onStart={runInSaved ? startSaved : startMatrix}
    />
  );
}

const SOURCE_ITEM_CLASS =
  "h-7 min-w-0 flex-none rounded-sm px-2.5 text-xs font-medium text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-semibold data-[state=on]:text-card-foreground data-[state=on]:shadow-sm first:rounded-sm last:rounded-sm";

/**
 * What an SDK suite runs with from the app. Its reporter data describes what
 * ran in the customer's CI, not a configuration MCPJam can launch, so the
 * person picks: a new setup composed here, or a saved project environment
 * (offered only when the project has one with servers).
 */
function SdkRunSource({
  offerSaved,
  saved,
  onChange,
  disabled,
}: {
  offerSaved: boolean;
  saved: boolean;
  onChange: (saved: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        This suite reports runs from your CI. Pick what to run it with here;
        the suite itself is not changed.
      </p>
      {offerSaved ? (
        <ToggleGroup
          type="single"
          value={saved ? "saved" : "new"}
          onValueChange={(value) => value && onChange(value === "saved")}
          aria-label="Run with"
          disabled={disabled}
          className="gap-0.5 bg-muted p-0.5"
        >
          <ToggleGroupItem value="new" className={SOURCE_ITEM_CLASS}>
            New setup
          </ToggleGroupItem>
          <ToggleGroupItem value="saved" className={SOURCE_ITEM_CLASS}>
            Saved environment
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
    </div>
  );
}

/** The project's environments with servers, for one run of an SDK suite. */
function SavedEnvironmentList({
  environments,
  value,
  onChange,
  hostNamesById,
  disabled,
}: {
  environments: readonly ProjectEnvironmentView[];
  value: string | undefined;
  onChange: (environmentId: string) => void;
  hostNamesById: ReadonlyMap<string, string | null>;
  disabled: boolean;
}) {
  return (
    <section data-testid="sdk-suite-run-environment">
      <h3 className="text-sm font-semibold">Environment</h3>
      <RadioGroup
        aria-label="Environment"
        value={value ?? ""}
        onValueChange={onChange}
        disabled={disabled}
        className="mt-3 grid gap-2"
      >
        {environments.map((environment) => {
          const id = `sdk-run-${environment.environmentId}`;
          const client =
            hostNamesById.get(environment.hostId) ??
            `Client …${environment.hostId.slice(-6)}`;
          return (
            <Label
              key={environment.environmentId}
              htmlFor={id}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
            >
              <RadioGroupItem id={id} value={environment.environmentId} />
              <span className="min-w-0 space-y-1">
                <span className="block text-sm">
                  {environment.name?.trim() || client}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {client} ·{" "}
                  {environment.modelId
                    ? compactModelIdTail(environment.modelId)
                    : "Client default"}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </section>
  );
}
