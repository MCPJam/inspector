import type { ComponentProps } from "react";
import {
  hasRubricChecksCapability,
  type SuiteCapabilitiesState,
} from "@/hooks/use-suite-capabilities";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { JudgeInstructionsEditor } from "../judge-instructions-editor";
import { RUBRIC_CHECK_ROW_IDENTITY_HINT } from "../judge-rubric-editor";
import { SuitePassOrFailSection } from "../suite-pass-or-fail-section";
import { SuiteStageFactsList } from "../suite-stage-facts-panel";
import type { EvalSuite, EvalSuiteRunListItem } from "../types";
import { useGroundedness } from "../use-groundedness";
import { useSelectedRun } from "../use-selected-run";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { useStageFactTargets } from "./use-stage-fact-targets";
import type { SuiteSettingsEditor } from "./use-suite-settings-editor";

type PassOrFailProps = ComponentProps<typeof SuitePassOrFailSection>;

/**
 * The suite's default evaluators: matching, default assertions and the judge.
 * Every case inherits these unless it overrides them.
 */
export function SuiteDefaultEvaluatorsFields({
  suite,
  projectId,
  editor,
  capabilities: capabilitiesResult,
  latestCompletedRun,
  availableModels,
  requireOrgKeys,
  onManageOrgProviders,
  onAddProvider,
  onGoToWhereItRuns,
}: {
  suite: EvalSuite;
  projectId: string | null;
  editor: SuiteSettingsEditor;
  capabilities: SuiteCapabilitiesState;
  /** The run the groundedness evidence is read from, when there is one. */
  latestCompletedRun: EvalSuiteRunListItem | null;
  availableModels: PassOrFailProps["availableModels"];
  requireOrgKeys?: boolean;
  onManageOrgProviders?: () => void;
  onAddProvider: PassOrFailProps["onAddProvider"];
  onGoToWhereItRuns: () => void;
}) {
  const {
    draft,
    dispatchDraft,
    draftDefaultPredicates,
    setDraftDefaultPredicates,
    suiteScenarioMigrationCount,
  } = editor;
  const { state: capabilitiesState, capabilities } = capabilitiesResult;
  const capabilitiesReady = capabilitiesState === "ready" && capabilities;
  const { capable: composeCapable } = useEvalComposeCapable(projectId);
  const { stageFactTargets, factsProjectServers, isAuthenticated } =
    useStageFactTargets(suite, projectId);
  const latestGroundednessRun = useSelectedRun(
    suite._id,
    latestCompletedRun?._id ?? null,
  );
  const groundedness = useGroundedness(latestGroundednessRun.run);

  return (
    <div data-setting-key="passOrFail" className="space-y-4">
      <SuitePassOrFailSection
        capabilities={capabilitiesReady ? capabilities : null}
        stageFacts={{
          connection: (
            <SuiteStageFactsList
              stage="connection"
              targets={stageFactTargets}
              projectServers={factsProjectServers}
              isAuthenticated={isAuthenticated}
              composeCapable={composeCapable}
              onGoToWhereItRuns={onGoToWhereItRuns}
            />
          ),
          discovery: (
            <SuiteStageFactsList
              stage="discovery"
              targets={stageFactTargets}
              projectServers={factsProjectServers}
              isAuthenticated={isAuthenticated}
              composeCapable={composeCapable}
              onGoToWhereItRuns={onGoToWhereItRuns}
            />
          ),
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
