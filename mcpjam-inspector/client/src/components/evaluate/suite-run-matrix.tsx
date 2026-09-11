import { useState } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { useHostList } from "@/hooks/useClients";
import { useAvailableModels } from "@/hooks/use-available-models";
import { useEnsureAdhocEnvironments } from "@/hooks/useProjectEnvironments";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import type { ModelSelection } from "@/components/environment-composer/environment-stack";
import { MAX_SUITE_ENVIRONMENTS } from "@/components/project-environments/environment-picker";
import { EvalTargetMatrix } from "./eval-target-matrix";
import {
  SuiteRunReviewContent,
  type SuiteRunReviewProps,
} from "./suite-run-review";

type PlannedCombination = {
  environmentId?: string;
  stack: Parameters<
    ReturnType<typeof useEnsureAdhocEnvironments>
  >[0]["stacks"][number];
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

/** Reuse exact saved environments; only new combinations need resolving. */
export function planRunMatrix(
  suite: SuiteRunReviewProps["suite"],
  environments: Environments,
  selections: Record<string, ModelSelection>,
) {
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
        }));
      const template =
        attached.find((environment) => environment.hostId === hostId) ??
        attached[0];
      return [
        {
          environmentId: undefined,
          stack: {
            hostId,
            modelId,
            serverAttachmentId:
              template?.serverAttachmentId ?? suite.serverAttachmentId,
            skillSelection: template?.skillSelection,
            secretSelection: template?.secretSelection,
            computerEnvironmentId: template?.computerEnvironmentId ?? undefined,
          },
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
  const plan = unresolved ? [] : planRunMatrix(suite, environments, selections);
  // Older deployments retain their launch path until they support model overrides.
  if (!capable && !pending) return <SuiteRunReviewContent {...props} />;
  const blocked =
    props.disabledReason ??
    (isLoading || pending || unresolved
      ? "Loading clients and models…"
      : plan.length > MAX_SUITE_ENVIRONMENTS
        ? `Choose up to ${MAX_SUITE_ENVIRONMENTS} client/model combinations.`
        : !plan.length
          ? "Choose at least one client and model."
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
        const resolved = missing.length
          ? await ensure({
              projectId,
              stacks: missing.map((item) => item.stack),
            })
          : [];
        let next = 0;
        const environmentIds = plan.map(
          (item) =>
            item.environmentId ?? resolved[next++]?.environment.environmentId,
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
