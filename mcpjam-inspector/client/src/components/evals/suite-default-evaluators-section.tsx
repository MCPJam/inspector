import { useCallback, useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import type { ModelDefinition } from "@/shared/types";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { splitPredicatesForMigration } from "@/shared/predicate-migration";
import { useHostList } from "@/hooks/useClients";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import {
  useProjectServers,
  useProjectServerAttachments,
} from "@/hooks/useViews";
import {
  hasRubricChecksCapability,
  type SuiteCapabilities,
} from "@/hooks/use-suite-capabilities";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { disambiguateLabels, environmentLabel } from "@/lib/environment-label";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { buildHostNamesById } from "./helpers";
import { JudgeInstructionsEditor } from "./judge-instructions-editor";
import { RUBRIC_CHECK_ROW_IDENTITY_HINT } from "./judge-rubric-editor";
import { SuitePassOrFailSection } from "./suite-pass-or-fail-section";
import {
  SuiteStageFactsList,
  type StageFactsTarget,
} from "./suite-stage-facts-panel";
import type { SuiteSettingsSheet } from "./use-suite-settings-sheet";
import type { EvalSuite } from "./types";

/**
 * The run targets the stage facts describe: attached environments when the
 * suite has them, else the legacy host attachments, else the suite's own
 * host config. A target that names a server GROUP knows its ids here; one
 * that uses the client's own servers cannot know them until the host config
 * loads, so the panel finishes that half.
 */
function useStageFactTargets(
  suite: EvalSuite,
  projectId: string | null,
): StageFactsTarget[] {
  const { isAuthenticated } = useConvexAuth();
  const projectEnvironments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  // A LOOKUP, so it opts into private scenario-backing clients: a run that
  // already resolved against a backing client should print its name.
  const { hosts: namableHosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  const hostNamesById = useMemo(
    () => buildHostNamesById(suite.hostAttachments, namableHosts),
    [suite.hostAttachments, namableHosts],
  );
  // The suite's OWN host config — what an attachment-less suite runs under.
  const canQuerySuiteHostConfig = useActorCanQuery();
  const suiteOwnHostConfig = useQuery(
    "hostConfigsV2:getSuiteConfig" as never,
    canQuerySuiteHostConfig && suite._id
      ? ({ suiteId: suite._id } as never)
      : "skip",
  ) as HostConfigDtoV2 | null | undefined;
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });

  return useMemo<StageFactsTarget[]>(() => {
    const attachmentById = new Map(
      (serverAttachments ?? []).map((row) => [row._id, row]),
    );
    // NOT gated on `composeCapable`: that capability decides whether this
    // deployment can EDIT client x model cells, not what a run fans out over.
    // A suite with attached environments runs one per environment either way —
    // `summarizeEnvironments` reads them the same way — so gating here reported
    // "no run target" for a suite that has several.
    if ((suite.environmentIds?.length ?? 0) > 0) {
      const rows = (suite.environmentIds ?? []).map((environmentId) => {
        const environment = projectEnvironments?.find(
          (row) => row.environmentId === environmentId,
        );
        return { environmentId, environment };
      });
      const labeled = disambiguateLabels(
        rows.map(({ environmentId, environment }) => ({
          environmentId,
          label: environment
            ? environmentLabel(environment, {
                hostName: (id) => hostNamesById.get(id) ?? undefined,
              })
            : environmentId,
        })),
      );
      return rows.map(({ environmentId, environment }, index) => {
        const attachment = environment?.serverAttachmentId
          ? attachmentById.get(environment.serverAttachmentId)
          : undefined;
        return {
          key: environmentId,
          label: labeled[index].label,
          hostId: environment?.hostId ?? "",
          environmentId,
          attachment: attachment
            ? { id: attachment._id, name: attachment.name }
            : null,
          servers: attachment
            ? { kind: "attachment" as const, ids: attachment.serverIds }
            : { kind: "host" as const, extraIds: [] },
        };
      });
    }
    // Legacy: a suite-level server attachment replaces every host's own picks
    // (see `EvalSuite.serverAttachmentId`), so it wins for all of them.
    const suiteAttachment = suite.serverAttachmentId
      ? attachmentById.get(suite.serverAttachmentId)
      : undefined;
    if ((suite.hostAttachments ?? []).length === 0) {
      // No environment and no attached client is still a RUN TARGET: the suite
      // executes under its own saved host config, falling back to the default
      // MCPJam client when it never wrote one (`loadSuiteHostConfig`). Saying
      // "no run target yet" here sent a reader to attach something the run does
      // not need. No `hostId`, because this config belongs to the suite rather
      // than to a client row there would be a page for.
      return suiteOwnHostConfig
        ? [
            {
              key: "suite-host",
              label: "This suite's own client",
              hostId: "",
              hostConfig: suiteOwnHostConfig,
              attachment: null,
              servers: { kind: "host" as const, extraIds: [] },
            },
          ]
        : [];
    }
    return (suite.hostAttachments ?? []).map((attachmentRow) => ({
      key: attachmentRow.namedHostId,
      label:
        hostNamesById.get(attachmentRow.namedHostId) ??
        attachmentRow.hostName ??
        attachmentRow.namedHostId,
      hostId: attachmentRow.namedHostId,
      attachment: suiteAttachment
        ? { id: suiteAttachment._id, name: suiteAttachment.name }
        : null,
      servers: suiteAttachment
        ? { kind: "attachment" as const, ids: suiteAttachment.serverIds }
        : {
            kind: "host" as const,
            extraIds: attachmentRow.enabledOptionalServerIds ?? [],
          },
    }));
  }, [
    suiteOwnHostConfig,
    suite.environmentIds,
    suite.hostAttachments,
    suite.serverAttachmentId,
    projectEnvironments,
    serverAttachments,
    hostNamesById,
  ]);
}

/** The suite's default evaluators: SuitePassOrFailSection with its stage facts. */
export function SuiteDefaultEvaluatorsSection({
  sheet,
  suite,
  projectId,
  capabilities,
  availableModels,
  requireOrgKeys,
  onManageOrgProviders,
  onAddProvider,
  onOpenSetting,
}: {
  sheet: SuiteSettingsSheet;
  suite: EvalSuite;
  projectId: string | null;
  capabilities: SuiteCapabilities | null;
  availableModels: ModelDefinition[];
  requireOrgKeys?: boolean;
  onManageOrgProviders?: () => void;
  onAddProvider: (() => void) | null;
  /** Where "Go to where it runs" lands; the sheet's own jump by default. */
  onOpenSetting?: (key: EvalSuiteSettingKey) => void;
}) {
  const { draft, dispatchDraft, groundedness } = sheet;
  const { isAuthenticated } = useConvexAuth();
  const { capable: composeCapable } = useEvalComposeCapable(projectId);
  const { servers: factsProjectServers } = useProjectServers({
    isAuthenticated,
    projectId,
  });
  const stageFactTargets = useStageFactTargets(suite, projectId);
  const openSetting = onOpenSetting ?? sheet.openSetting;
  const draftDefaultPredicates = draft.current.defaultPredicates;
  const setDraftDefaultPredicates = useCallback(
    // Both forms, matching the `useState` setter this replaced — `AddCheckMenu`
    // passes an updater, and the reducer resolves it against the authoritative
    // draft rather than whatever this render closed over.
    (next: Predicate[] | ((previous: Predicate[]) => Predicate[])) =>
      dispatchDraft({ type: "edit", key: "defaultPredicates", value: next }),
    [dispatchDraft],
  );
  const suiteScenarioMigrationCount = useMemo(
    () =>
      splitPredicatesForMigration(draftDefaultPredicates).scenarioAsserts
        .length,
    [draftDefaultPredicates],
  );
  const stageFacts = (stage: "connection" | "discovery") => (
    <SuiteStageFactsList
      stage={stage}
      targets={stageFactTargets}
      projectServers={factsProjectServers}
      isAuthenticated={isAuthenticated}
      composeCapable={composeCapable}
      onGoToWhereItRuns={() => openSetting("environments")}
    />
  );

  return (
    <div data-setting-key="passOrFail" className="space-y-4">
      <SuitePassOrFailSection
        capabilities={capabilities}
        stageFacts={{
          connection: stageFacts("connection"),
          discovery: stageFacts("discovery"),
        }}
        matchOptions={draft.current.defaultMatchOptions}
        onMatchOptionsChange={(next: EvalMatchOptions | undefined) =>
          dispatchDraft({
            type: "edit",
            key: "defaultMatchOptions",
            value: next,
          })
        }
        predicates={draftDefaultPredicates}
        onPredicatesChange={setDraftDefaultPredicates}
        judgeConfig={draft.current.judgeConfig}
        onJudgeConfigChange={(next) =>
          dispatchDraft({
            type: "edit",
            key: "judgeConfig",
            value: next,
          })
        }
        availableModels={availableModels}
        requireOrgKeys={requireOrgKeys}
        onManageOrgProviders={onManageOrgProviders}
        onAddProvider={onAddProvider}
        rubricEditor={
          <JudgeInstructionsEditor
            value={draft.current.judgeRubric}
            onChange={(next) =>
              dispatchDraft({
                type: "edit",
                key: "judgeRubric",
                value: next,
              })
            }
            rowIdentityHint={
              hasRubricChecksCapability(capabilities)
                ? RUBRIC_CHECK_ROW_IDENTITY_HINT
                : undefined
            }
          />
        }
        judgeRubric={draft.current.judgeRubric}
        groundednessEvidence={{
          result: groundedness.result ?? null,
          pending: groundedness.pending,
        }}
        scenarioMigrationNotice={
          suiteScenarioMigrationCount > 0 ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {suiteScenarioMigrationCount} scenario assertion
              {suiteScenarioMigrationCount === 1 ? "" : "s"} in defaults —
              migrate per case in Steps.
            </p>
          ) : null
        }
      />
    </div>
  );
}
