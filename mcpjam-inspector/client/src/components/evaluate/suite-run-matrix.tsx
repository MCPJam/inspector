import { useState } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { useHostList } from "@/hooks/useClients";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  useEnsureAdhocEnvironments,
  useProjectEnvironments,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { useEnvironmentCapabilities } from "@/hooks/use-environment-capabilities";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { compactModelIdTail } from "@/lib/environment-label";
import type { ModelSelection } from "@/components/environment-composer/environment-stack";
import { MAX_SUITE_ENVIRONMENTS } from "@/components/project-environments/environment-picker";
import { EvalTargetMatrix } from "./eval-target-matrix";
import {
  adhocSkillSelection,
  chooseTemplate,
  lacksServerSource,
  unpreservableReason,
} from "./environment-template";
import {
  SuiteRunReviewContent,
  type SuiteRunReviewProps,
} from "./suite-run-review";

type PlannedCombination = {
  environmentId?: string;
  stack: Parameters<
    ReturnType<typeof useEnsureAdhocEnvironments>
  >[0]["stacks"][number];
  /**
   * With backend derivation: build this cell server-side from the stored
   * source (every pin kept) instead of composing `stack`.
   */
  derive?: {
    sourceEnvironmentId: string;
    expectedRevision: number;
    overrides: { hostId: string; modelId: string | null };
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
      explicitModelIds: [],
    });
    if (environment.modelId) {
      if (!selection.explicitModelIds.includes(environment.modelId))
        selection.explicitModelIds.push(environment.modelId);
    } else selection.includeClientDefaults = true;
  }
  if (!suite.environmentIds?.length) {
    for (const host of suite.hostAttachments ?? [])
      selections[host.namedHostId] = {
        includeClientDefaults: true,
        explicitModelIds: [],
      };
  }
  return selections;
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
    const models = [
      ...(selection.includeClientDefaults ? [undefined] : []),
      ...selection.explicitModelIds,
    ];
    return models.flatMap<PlannedCombination>((modelId) => {
      const existing = attached.filter(
        (environment) =>
          environment.hostId === hostId && environment.modelId === modelId,
      );
      if (existing.length)
        return existing.map((environment) => ({
          environmentId: environment.environmentId,
          stack: { hostId, modelId },
          missingGroup: lacksServerSource(environment),
        }));
      const onHost = attached.filter(
        (environment) => environment.hostId === hostId,
      );
      const bare = { hostId, ...(modelId ? { modelId } : {}) };
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
      if (choice.kind === "none") return [{ stack: bare, missingGroup: true }];
      if (options.lossless)
        return [
          {
            stack: bare,
            derive: {
              sourceEnvironmentId: choice.source.environmentId,
              expectedRevision: choice.source.revision,
              overrides: { hostId, modelId: modelId ?? null },
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
      const skillSelection = adhocSkillSelection(choice.composition);
      return [
        {
          stack: {
            ...bare,
            ...(choice.composition.serverAttachmentId
              ? { serverAttachmentId: choice.composition.serverAttachmentId }
              : {}),
            ...(skillSelection ? { skillSelection } : {}),
            ...(choice.composition.computerEnvironmentId
              ? {
                  computerEnvironmentId:
                    choice.composition.computerEnvironmentId,
                }
              : {}),
          },
          missingGroup: lacksServerSource(choice.composition),
        },
      ];
    });
  });
}

export function ConfiguredSuiteRunReview(
  props: SuiteRunReviewProps & { projectId: string },
) {
  const { suite, projectId, environments = [] } = props;
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { availableModels } = useAvailableModels({ projectId });
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
  const selections = draft ?? seedRunMatrix(suite, environments);
  const unresolved = suite.environmentIds?.some(
    (id) =>
      !environments.some((environment) => environment.environmentId === id),
  );
  const plan = unresolved
    ? []
    : planRunMatrix(suite, environments, selections, { lossless });
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
  // Older deployments retain their launch path until they support model overrides.
  if (!capable && !pending) return <SuiteRunReviewContent {...props} />;
  // An SDK suite only RECORDS runs its CI executed; it has no client, model
  // or servers of its own to launch. Running it from the app means picking a
  // project environment for this one run.
  if (!suite.environmentIds?.length && suite.source === "sdk")
    return <SdkSuiteRunReview {...props} projectId={projectId} />;
  // A suite with no environments launches its own (legacy) configuration: the
  // runtime knows where that suite keeps its servers, and this dialog does
  // not. Composing environments from the suite's legacy fields is how a run
  // ended up with no servers.
  if (!suite.environmentIds?.length)
    return <SuiteRunReviewContent {...props} />;
  const blocked =
    props.disabledReason ??
    (isLoading || pending || unresolved
      ? "Loading clients and models…"
      : plan.length > MAX_SUITE_ENVIRONMENTS
        ? `Choose up to ${MAX_SUITE_ENVIRONMENTS} client/model combinations.`
        : !plan.length || missingModel
          ? "Choose at least one client and model."
          : blockedCell
            ? blockedCell
            : missingGroup
              ? "A selected client has no server group, so its run would connect no servers. Pick a server group in suite settings."
              : null);
  return (
    <SuiteRunReviewContent
      {...props}
      disabledReason={blocked}
      matrix={{
        count: plan.length,
        render: (starting) => (
          <EvalTargetMatrix
            hostIds={Object.keys(selections)}
            hosts={hosts}
            modelSelection={undefined}
            modelSelectionsByHost={selections}
            availableModels={availableModels}
            maxTargets={MAX_SUITE_ENVIRONMENTS}
            projectId={projectId}
            disabled={starting || pending || Boolean(unresolved)}
            modelsEditable
            inModal
            onHostsChange={(ids) =>
              setDraft(
                Object.fromEntries(
                  ids.map((id) => [
                    id,
                    selections[id] ?? {
                      includeClientDefaults: true,
                      explicitModelIds: [],
                    },
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
                  Object.entries(selections).filter(([id]) => id !== hostId),
                ),
              )
            }
          />
        ),
      }}
      onStart={async (_, options) => {
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
        const derivedRows = derived.length
          ? ((await convex.mutation(
              "projectEnvironments:deriveEnvironments" as any,
              {
                projectId,
                derivations: derived.map((item) => item.derive),
              },
            )) as Array<{ environment?: { environmentId?: string } }>)
          : [];
        const resolved = composed.length
          ? await ensure({
              projectId,
              stacks: composed.map((item) => item.stack),
            })
          : [];
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
      }}
    />
  );
}

/**
 * Run an SDK suite from the app in a project environment the person picks.
 *
 * The suite's reporter data describes what ran in the customer's CI, not a
 * configuration MCPJam can launch, so nothing is inferred from it: the run
 * uses the picked environment (its client, model and servers) through
 * `ephemeralEnvironment`, without attaching it to the suite. On a backend
 * without ephemeral launches the dialog keeps the suite's own launch.
 */
export function SdkSuiteRunReview(
  props: SuiteRunReviewProps & { projectId: string },
) {
  const { projectId, hostNamesById } = props;
  const environments = useProjectEnvironments(projectId);
  const capabilities = useEnvironmentCapabilities(projectId);
  const [picked, setPicked] = useState<string>();
  // Older backends (no ephemeral launches) keep the suite's own launch.
  if (
    capabilities !== undefined &&
    capabilities?.ephemeralEnvironmentLaunch !== true
  )
    return <SuiteRunReviewContent {...props} />;
  const launchable = (environments ?? []).filter(
    (environment) => !environment.archivedAt && !lacksServerSource(environment),
  );
  const pickedEnvironment = launchable.find(
    (environment) => environment.environmentId === picked,
  );
  const blocked =
    props.disabledReason ??
    (environments === undefined || capabilities === undefined
      ? "Loading environments…"
      : launchable.length === 0
        ? "This project has no environment with servers yet. Create one on the Environments page to run this suite from here."
        : !pickedEnvironment
          ? "Pick the environment to run this suite in."
          : null);
  return (
    <SuiteRunReviewContent
      {...props}
      disabledReason={blocked}
      matrix={{
        count: pickedEnvironment ? 1 : 0,
        render: (starting) => (
          <section data-testid="sdk-suite-run-environment">
            <h3 className="text-sm font-semibold">Environment</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              This suite reports runs from your CI. Pick the client, model and
              servers to run it with here; the suite itself is not changed.
            </p>
            {launchable.length > 0 ? (
              <RadioGroup
                aria-label="Environment"
                value={picked ?? ""}
                onValueChange={setPicked}
                disabled={starting}
                className="mt-3 grid gap-2"
              >
                {launchable.map((environment) => {
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
                      <RadioGroupItem
                        id={id}
                        value={environment.environmentId}
                      />
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
            ) : null}
          </section>
        ),
      }}
      onStart={(suite, options) =>
        props.onStart(
          {
            ...suite,
            environmentIds: [pickedEnvironment!.environmentId],
            hostAttachments: [],
          },
          { ...options, ephemeralEnvironment: true },
        )
      }
    />
  );
}
