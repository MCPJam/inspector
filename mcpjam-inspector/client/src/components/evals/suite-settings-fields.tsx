import {
  EVAL_GRADING_VALIDITY_HINTS,
  EVAL_GRADING_VALIDITY_LABELS,
  EVAL_ITERATION_RULE_HINTS,
  EVAL_ITERATION_RULE_LABELS,
  EVAL_PASS_CRITERION_SCOPE_HINTS,
  EVAL_PASS_CRITERION_SCOPE_LABELS,
  DEFAULT_SUITE_WIDE_THRESHOLD_PERCENT,
} from "@mcpjam/sdk/contract";
import { useSandboxImages } from "@/hooks/useSandboxImages";
import { useEphemeralCloudAvailable } from "@/hooks/useProjectComputer";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import {
  CloudUnreachableNotice,
  EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE,
} from "@/components/computer/CloudUnreachableNotice";
import { useEvalComposeCapable } from "@/components/environment-composer/use-eval-compose-capable";
import { evalSuitePinsSandboxImage } from "./helpers";
import { SuiteClientsSettings } from "./suite-clients-settings";
import { SuiteEnvironmentComposerBar } from "./suite-environment-composer-bar";
import { PassCriteriaSelector } from "./pass-criteria-selector";
import {
  PerCaseIterationsControl,
  PerCasePassThresholdControl,
  VerdictValidityControls,
} from "./suite-policy-controls";
import { SuiteQualityGateSection } from "./suite-quality-gate-section";
import {
  CI_OWNED_REASON_COPY,
  featureDisabledReason,
  PERMISSION_REASON_COPY,
} from "./capability-reasons";
import { suiteImageSetting } from "./suite-settings-draft";
import {
  LedgerRowChips,
  SuiteBudgetSettingsRows,
  useSuiteAttachmentUpdaters,
} from "./suite-settings-row-parts";
import { SuiteSettingsRow } from "./suite-settings-row";
import { LEGACY_CLIENTS_ROW_LABEL } from "./suite-settings-groups";
import type { SuiteConfigLock } from "./use-suite-config-lock";
import {
  useComputerEnvironmentRowVisible,
  type SuiteSettingsSheet,
} from "./use-suite-settings-sheet";
import type { EvalSuite } from "./types";

/** The settings rows from Pass criteria to Model call retries, in order. */
export function SuiteSettingsFields({
  sheet,
  suite,
  projectId,
  lock,
  readOnlyConfig = false,
}: {
  sheet: SuiteSettingsSheet;
  suite: EvalSuite;
  projectId: string | null;
  lock: SuiteConfigLock;
  readOnlyConfig?: boolean;
}) {
  const { draft, dispatchDraft, rowIsDirty, rowIsConflict } = sheet;
  const { capabilities, capabilitiesState, configLocked } = lock;
  const chips = (key: EvalSuiteSettingKey) => (
    <LedgerRowChips dirty={rowIsDirty(key)} conflict={rowIsConflict(key)} />
  );
  // Which criterion SCOPE the sheet is editing, and therefore which field and
  // which units each grading row shows. Read from the DRAFT rather than the
  // suite so the rows follow a scope change the moment it is drafted.
  const isVerdictPolicyV2 = draft.current.verdictPolicyVersion === 2;
  const defaultMinimumPassRate =
    draft.current.defaultPassCriteria?.minimumPassRate ??
    DEFAULT_SUITE_WIDE_THRESHOLD_PERCENT;
  const { capable: composeCapable } = useEvalComposeCapable(projectId);
  const computerEnvironmentRowVisible = useComputerEnvironmentRowVisible(
    lock,
    projectId,
  );
  const computerEnvironments = useSandboxImages(
    computerEnvironmentRowVisible ? projectId : null,
  );
  const ephemeralCloudAvailable = useEphemeralCloudAvailable();
  const projectEnvironments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const suitePinsSandboxImage = evalSuitePinsSandboxImage(
    suite,
    projectEnvironments ?? undefined,
  );

  const { handleUpdateHostAttachments, handleServerAttachmentUpdate } =
    useSuiteAttachmentUpdaters(suite._id);

  // CI OWNERSHIP IS CHECKED FIRST, ahead of every feature flag and every
  // permission. A role change cannot unlock these rows, so "you don't have
  // permission" would send the reader to ask for access they already hold.
  const ciOwnedReason = configLocked ? CI_OWNED_REASON_COPY : undefined;
  const computerEnvironmentDisabledReason =
    ciOwnedReason ??
    (!capabilities
      ? undefined
      : (featureDisabledReason(
          capabilities.features?.["sandbox-images"] ??
            capabilities.features?.computers,
        ) ??
        (capabilities.permissions?.["suite.configure"] === false
          ? PERMISSION_REASON_COPY
          : undefined))) ??
    (suiteImageSetting(suite).mixed
      ? "These environments pin different images. Change each one's image on the Environments page."
      : undefined);

  return (
    <>
      {/*
        THREE SECTIONS, in the order a reader asks the questions: what
        must pass, how many times, and does it regress against a
        baseline. Within each section the SCOPE picks the control, and the
        scope's own words come from the shared grading vocabulary. No section
        offers a switch between the two: the criteria differ in scope as
        well as units, so converting one into the other re-decides every
        multi-case suite and is not an edit a threshold field can make.
      */}
      <SuiteSettingsRow
        settingKey="policy"
        className="pr-6"
        chained={false}
        data-subsection-id="policy"
        accessory={chips("policy")}
        hint={
          isVerdictPolicyV2
            ? EVAL_PASS_CRITERION_SCOPE_HINTS.perCase
            : EVAL_PASS_CRITERION_SCOPE_HINTS.suiteWide
        }
      >
        {isVerdictPolicyV2 ? (
          <PerCasePassThresholdControl
            aligned
            defaults={draft.current.verdictPolicyDefaults}
            onChange={(next) =>
              dispatchDraft({
                type: "edit",
                key: "verdictPolicyDefaults",
                value: next,
              })
            }
          />
        ) : (
          /* Stamped by hand, nested inside the criterion section: the
             suite-wide threshold stays reachable from the API on its
             own. The parity ratchet reads the attribute, not the
             component. */
          <div
            className="flex items-center justify-between gap-4"
            data-setting-key="minimumAccuracy"
          >
            <span className="text-xs text-muted-foreground">
              {EVAL_PASS_CRITERION_SCOPE_LABELS.suiteWide}
            </span>
            <PassCriteriaSelector
              aligned
              hideLabel
              minimumPassRate={defaultMinimumPassRate}
              onMinimumPassRateChange={(rate) =>
                dispatchDraft({
                  type: "edit",
                  key: "defaultPassCriteria",
                  value: { minimumPassRate: rate },
                })
              }
            />
          </div>
        )}
        {isVerdictPolicyV2 ? (
          <div data-setting-key="validity" className="space-y-2">
            <p className="text-xs font-medium text-foreground">
              {EVAL_GRADING_VALIDITY_LABELS.enforced}
            </p>
            <p className="text-[11px] text-muted-foreground/60">
              {EVAL_GRADING_VALIDITY_HINTS.enforced}
            </p>
            <VerdictValidityControls
              defaults={draft.current.verdictPolicyDefaults}
              onChange={(next) =>
                dispatchDraft({
                  type: "edit",
                  key: "verdictPolicyDefaults",
                  value: next,
                })
              }
            />
          </div>
        ) : (
          /* NOT an inactive control, and not a blank space: a
             suite-wide suite has no validity phase at all, so
             `inconclusive` is not among the verdicts its runs can
             reach. */
          <p className="text-[11px] text-muted-foreground/60">
            {EVAL_GRADING_VALIDITY_HINTS.notEnforced}
          </p>
        )}
      </SuiteSettingsRow>

      <SuiteSettingsRow
        settingKey="iterations"
        className="pr-6"
        chained={false}
        data-subsection-id="iterations"
        accessory={chips("iterations")}
        hint={
          isVerdictPolicyV2
            ? EVAL_ITERATION_RULE_HINTS.defaultCount
            : EVAL_ITERATION_RULE_HINTS.caseCountWithFloor
        }
      >
        {isVerdictPolicyV2 ? (
          <PerCaseIterationsControl
            aligned
            defaults={draft.current.verdictPolicyDefaults}
            onChange={(next) =>
              dispatchDraft({
                type: "edit",
                key: "verdictPolicyDefaults",
                value: next,
              })
            }
          />
        ) : (
          <div
            className="flex items-center justify-between gap-4"
            data-setting-key="minimumIterations"
          >
            <span className="text-xs text-muted-foreground">
              {EVAL_ITERATION_RULE_LABELS.caseCountWithFloor}
            </span>
            <select
              className="h-8 w-40 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              value={draft.current.minIterations ?? ""}
              aria-label="Minimum iterations per case for every run"
              onChange={(e) => {
                const raw = e.target.value;
                dispatchDraft({
                  type: "edit",
                  key: "minIterations",
                  value: raw === "" ? undefined : Number(raw),
                });
              }}
            >
              {/* "Off" is the suite's real state — no floor — and not a
                  stand-in for 1. */}
              <option value="">Off</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        )}
      </SuiteSettingsRow>

      <SuiteSettingsRow
        settingKey="qualityGate"
        className="pr-6"
        chained={false}
        data-subsection-id="qualityGate"
        accessory={chips("qualityGate")}
        hint="Fail a run when it regresses against a baseline run, whatever the pass criteria said."
      >
        <SuiteQualityGateSection
          simplified
          policy={draft.current.gatePolicy}
          onChange={(next) =>
            dispatchDraft({ type: "edit", key: "gatePolicy", value: next })
          }
          capabilities={capabilities}
          capabilitiesState={capabilitiesState}
        />
      </SuiteSettingsRow>

      <SuiteSettingsRow
        settingKey="environments"
        chained={false}
        data-subsection-id="environments"
        label={composeCapable ? undefined : LEGACY_CLIENTS_ROW_LABEL}
        hint="One run per client and model combination. Changes here save right away."
      >
        {projectId ? (
          <SuiteClientsSettings
            suite={suite}
            projectId={projectId}
            readOnly={
              readOnlyConfig ||
              capabilities?.permissions?.["suite.configure"] === false
            }
          />
        ) : null}
        {/*
          The legacy axes, and the ONLY editor for them. The composer decides
          for itself which mode it is in, so it is safe to render beside the
          matrix rather than instead of it.
        */}
        {projectId && !composeCapable ? (
          <div className="mt-3">
            <SuiteEnvironmentComposerBar
              containerVariant="inline"
              suite={suite}
              onUpdate={handleUpdateHostAttachments}
              onUpdateServerAttachment={handleServerAttachmentUpdate}
              omitComputers
            />
          </div>
        ) : null}
        {projectId ? null : (
          <SuiteEnvironmentComposerBar
            suite={suite}
            onUpdate={handleUpdateHostAttachments}
            onUpdateServerAttachment={handleServerAttachmentUpdate}
            omitComputers
          />
        )}
      </SuiteSettingsRow>

      {computerEnvironmentRowVisible ? (
        <SuiteSettingsRow
          settingKey="computerEnvironment"
          chained={false}
          data-subsection-id="computerEnvironment"
          disabledReason={computerEnvironmentDisabledReason}
          hint="Each iteration boots a fresh MCPJam cloud sandbox from this image, never on this machine. Build the image first, or the run fails fast."
        >
          <select
            className="h-8 max-w-[16rem] rounded-md border border-input bg-background px-2 text-xs text-foreground"
            value={draft.current.computerEnvironmentId ?? ""}
            aria-label="Reproducible computer environment for eval runs"
            onChange={(e) =>
              dispatchDraft({
                type: "edit",
                key: "computerEnvironmentId",
                value: e.target.value || undefined,
              })
            }
          >
            <option value="">None (default image)</option>
            {(computerEnvironments ?? []).map((env) => {
              const ready = env.currentBuild?.status === "ready";
              return (
                <option key={env.environmentId} value={env.environmentId}>
                  {env.name}
                  {ready ? "" : " (not built)"}
                </option>
              );
            })}
          </select>
          {suitePinsSandboxImage && ephemeralCloudAvailable === false ? (
            <div className="mt-2">
              <CloudUnreachableNotice
                data-testid="suite-eval-cloud-unreachable"
                message={EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE}
                detail="Runs started here would fail their computer setup, so Run all is off until cloud sandboxes are reachable."
              />
            </div>
          ) : null}
        </SuiteSettingsRow>
      ) : null}
      <SuiteBudgetSettingsRows sheet={sheet} />
    </>
  );
}
